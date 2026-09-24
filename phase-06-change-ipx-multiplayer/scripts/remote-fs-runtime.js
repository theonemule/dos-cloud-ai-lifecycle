var REMOTEFS={
nextId:1,
transportSession:"emu-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2),
launchSession:null,
bridge:null,
bridgeControl:null,
bridgeRequest:null,
bridgeResponse:null,
bridgeMode:null,
bridgeInitialized:false,
bridgeBufferSize:4*1024*1024,
metaCache:new Map(),
dirCache:new Map(),
metaTtlMs:3000,
dirTtlMs:3000,
readAheadMin:128*1024,
readAheadMax:1024*1024,
readCacheMaxBytes:64*1024*1024,
readCacheTtlMs:3000,
readCacheBytes:0,
readCache:new Map(),
readHandleCache:new Map(),
readHandleCacheMax:256,
writeBufferMax:256*1024,
writeFlushMs:500,
errno:{EACCES:2,EAGAIN:6,EBADF:8,EEXIST:20,EINVAL:28,EIO:29,EISDIR:31,ENOENT:44,ENOSPC:51,ENOSYS:52,ENOTDIR:54,ENOTEMPTY:55,EPERM:63,EROFS:69,ESPIPE:70},
encodePacket(header,payload){
 const encoder=new TextEncoder();
 const h=encoder.encode(JSON.stringify(header));
 const p=payload&&payload.length?payload:new Uint8Array(0);
 const out=new Uint8Array(4+h.length+p.length);
 new DataView(out.buffer).setUint32(0,h.length,false);
 out.set(h,4);
 out.set(p,4+h.length);
 return out;
},
decodePacket(input){
 const data=input instanceof Uint8Array?input:new Uint8Array(input);
 if(data.length<4)throw new Error("remote filesystem response too short");
 const headerLength=new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(0,false);
 if(headerLength<2||headerLength>64*1024||4+headerLength>data.length)throw new Error("invalid remote filesystem response");
 const header=JSON.parse(new TextDecoder().decode(data.subarray(4,4+headerLength)));
 return {header,payload:data.slice(4+headerLength)};
},
prepareArgs(args){
 const prepared={...(args||{})};
 const fields=["path","oldPath","newPath"];
 if(!this.launchSession){
  for(const field of fields){
   const value=prepared[field];
   if(typeof value!=="string"||!value)continue;
   const normalized=value.replaceAll("\\","/").replace(/^\/+|\/+$/g,"");
   const first=normalized.split("/")[0];
   if(first&&/^[A-Za-z0-9_-]{20,}$/.test(first)){
    this.launchSession=first;
    break;
   }
  }
 }
 if(this.launchSession){
  for(const field of fields){
   if(typeof prepared[field]!=="string")continue;
   let value=prepared[field].replaceAll("\\","/").replace(/^\/+|\/+$/g,"");
   if(value===this.launchSession)value="";
   else if(value.startsWith(this.launchSession+"/"))value=value.slice(this.launchSession.length+1);
   prepared[field]=value;
  }
 }
 return prepared;
},
canUseBridge(){
 return typeof Worker!=="undefined"&&typeof SharedArrayBuffer!=="undefined"&&typeof Atomics!=="undefined"&&self.crossOriginIsolated===true;
},
prewarmBridge(){
 if(this.bridgeMode==="http"||this.bridge)return Boolean(this.bridge);
 if(!this.canUseBridge()){
  this.bridgeMode="http";
  console.info("REMOTEFS transport: synchronous HTTP fallback");
  return false;
 }
 try{
  const controlSab=new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT*4);
  const requestSab=new SharedArrayBuffer(this.bridgeBufferSize);
  const responseSab=new SharedArrayBuffer(this.bridgeBufferSize);
  this.bridgeControl=new Int32Array(controlSab);
  this.bridgeRequest=new Uint8Array(requestSab);
  this.bridgeResponse=new Uint8Array(responseSab);
  this.bridgeBuffers={controlSab,requestSab,responseSab};
  const workerUrl=new URL("/emulators/remote-fs-bridge.js",self.location.origin).href;
  this.bridge=new Worker(workerUrl);
  this.bridge.onmessage=event=>{
   const message=event.data||{};
   if(message.type==="diagnostic")console.info("REMOTEFS bridge",message.stage,message.detail||"");
  };
  this.bridge.onerror=event=>console.error("REMOTEFS bridge worker error",event.message||event);
  this.bridgeMode="websocket";
  console.info("REMOTEFS transport worker prewarmed");
  return true;
 }catch(e){
  console.warn("REMOTEFS WebSocket bridge unavailable; using HTTP fallback",e);
  try{this.bridge&&this.bridge.terminate()}catch(_){}
  this.bridge=null;
  this.bridgeMode="http";
  return false;
 }
},
ensureBridge(){
 if(this.bridgeMode==="http")return false;
 if(!this.bridge&&!this.prewarmBridge())return false;
 if(!this.bridgeInitialized){
  const {controlSab,requestSab,responseSab}=this.bridgeBuffers;
  this.bridge.postMessage({
   type:"init",
   control:controlSab,
   request:requestSab,
   response:responseSab,
   launch:this.launchSession,
   session:this.transportSession
  });
  this.bridgeInitialized=true;
  console.info("REMOTEFS transport: WebSocket bridge with SharedArrayBuffer");
 }
 return true;
},
rpcViaBridge(request){
 if(request.length>this.bridgeRequest.length)throw new Error("REMOTEFS bridge request exceeds shared buffer");
 this.bridgeRequest.set(request,0);
 Atomics.store(this.bridgeControl,1,request.length);
 Atomics.store(this.bridgeControl,2,0);
 Atomics.store(this.bridgeControl,3,0);
 Atomics.store(this.bridgeControl,0,1);
 this.bridge.postMessage({type:"rpc"});
 const waited=Atomics.wait(this.bridgeControl,0,1,35000);
 if(waited==="timed-out")throw new Error("REMOTEFS WebSocket bridge timeout");
 const error=Atomics.load(this.bridgeControl,3);
 const responseLength=Atomics.load(this.bridgeControl,2);
 Atomics.store(this.bridgeControl,0,0);
 if(error)throw new Error("REMOTEFS WebSocket bridge failure "+error);
 if(responseLength<=0||responseLength>this.bridgeResponse.length)throw new Error("REMOTEFS invalid bridge response length");
 return this.decodePacket(this.bridgeResponse.slice(0,responseLength));
},
rpcViaHttp(request,op){
 if(typeof XMLHttpRequest==="undefined")throw new FS.ErrnoError(58);
 const origin=new URL(self.location.origin);
 const url=origin.origin+"/api/fs?client=emulator&launch="+encodeURIComponent(this.launchSession)+"&session="+encodeURIComponent(this.transportSession);
 const xhr=new XMLHttpRequest();
 try{
  xhr.open("POST",url,false);
  xhr.responseType="arraybuffer";
  xhr.withCredentials=true;
  xhr.setRequestHeader("Content-Type","application/octet-stream");
  xhr.send(request);
 }catch(e){
  console.error("REMOTEFS HTTP RPC failed",op,e);
  throw new FS.ErrnoError(29);
 }
 if(xhr.status!==200||!xhr.response){
  console.error("REMOTEFS HTTP error",op,xhr.status,xhr.statusText);
  throw new FS.ErrnoError(29);
 }
 try{return this.decodePacket(xhr.response)}
 catch(e){
  console.error("REMOTEFS response decode failed",op,e);
  throw new FS.ErrnoError(29);
 }
},
rpc(op,args,payload){
 const prepared=this.prepareArgs(args);
 if(!this.launchSession)throw new FS.ErrnoError(2);
 const request=this.encodePacket({id:this.nextId++,op,...prepared},payload);
 let response;
 try{
  response=this.ensureBridge()?this.rpcViaBridge(request):this.rpcViaHttp(request,op);
 }catch(e){
  console.error("REMOTEFS transport failed",op,e);
  throw new FS.ErrnoError(29);
 }
 if(!response.header.ok){
  const err=new FS.ErrnoError(this.errno[response.header.code]||29);
  err.remoteCode=response.header.code||"EIO";
  throw err;
 }
 return response;
},
cacheKey(path){return String(path||"").replaceAll("\\","/").replace(/^\/+|\/+$/g,"").toLocaleLowerCase("en-US")},
cacheMeta(path,meta){
 if(!meta)return meta;
 const value={
  size:Number(meta.size)||0,
  directory:Boolean(meta.directory),
  file:meta.file===undefined?!meta.directory:Boolean(meta.file),
  mtimeMs:Number(meta.mtimeMs)||Date.now()
 };
 this.metaCache.set(this.cacheKey(path),{value,expires:Date.now()+this.metaTtlMs});
 return value;
},
cacheMissing(path){
 this.metaCache.set(this.cacheKey(path),{missing:true,expires:Date.now()+this.metaTtlMs});
},
getCachedMeta(path){
 const key=this.cacheKey(path);
 const item=this.metaCache.get(key);
 if(!item)return null;
 if(item.expires<Date.now()){this.metaCache.delete(key);return null}
 if(item.missing){
  const err=new FS.ErrnoError(this.errno.ENOENT);
  err.remoteCode="ENOENT";
  throw err;
 }
 return item.value;
},
invalidateCaches(path){
 if(path){
  const key=this.cacheKey(path);
  this.metaCache.delete(key);
  this.dirCache.delete(this.cacheKey(this.parentPath(path)));
  this.dropReadCache(path);
 }else{
  this.metaCache.clear();
  this.dirCache.clear();
  this.clearReadCache();
 }
},
join(parent,name){
 const base=parent&&parent.remotePath?parent.remotePath:"";
 return base?base+"/"+name:name;
},
parentPath(path){
 const normalized=String(path||"").replaceAll("\\","/").replace(/^\/+|\/+$/g,"");
 const at=normalized.lastIndexOf("/");
 return at<0?"":normalized.slice(0,at);
},
getCachedDirectory(parentPath){
 const key=this.cacheKey(parentPath);
 const cached=this.dirCache.get(key);
 if(!cached)return null;
 if(cached.expires<Date.now()){this.dirCache.delete(key);return null}
 return cached;
},
findCachedDirEntry(parentPath,name){
 const cached=this.getCachedDirectory(parentPath);
 if(!cached)return null;
 const target=String(name).toLocaleLowerCase("en-US");
 return cached.entries.find(entry=>String(entry.name).toLocaleLowerCase("en-US")===target)||null;
},
statPath(path){
 const cached=this.getCachedMeta(path);
 if(cached)return cached;
 try{
  const r=this.rpc("stat",{path}).header;
  return this.cacheMeta(path,r);
 }catch(e){
  if(e.remoteCode==="ENOENT")this.cacheMissing(path);
  throw e;
 }
},
listPath(path){
 const key=this.cacheKey(path);
 const cached=this.dirCache.get(key);
 if(cached&&cached.expires>=Date.now())return cached.entries;
 if(cached)this.dirCache.delete(key);
 const r=this.rpc("list",{path}).header;
 const entries=r.entries||[];
 this.dirCache.set(key,{entries,expires:Date.now()+this.dirTtlMs});
 for(const entry of entries)this.cacheMeta(path?path+"/"+entry.name:entry.name,entry);
 return entries;
},
clearReadCache(){
 this.readCache.clear();
 this.readCacheBytes=0;
},
dropReadCache(path){
 const key=this.cacheKey(path);
 const cached=this.readCache.get(key);
 if(cached){
  this.readCacheBytes-=cached.data.length;
  this.readCache.delete(key);
 }
},
cacheRead(path,start,data,size,mtimeMs){
 if(!data||!data.length)return;
 const key=this.cacheKey(path);
 const previous=this.readCache.get(key);
 if(previous)this.readCacheBytes-=previous.data.length;
 const copy=data.slice();
 this.readCache.set(key,{start,data:copy,size,mtimeMs,at:Date.now(),expires:Date.now()+this.readCacheTtlMs});
 this.readCacheBytes+=copy.length;
 while(this.readCacheBytes>this.readCacheMaxBytes&&this.readCache.size){
  let oldestKey=null,oldestAt=Infinity;
  for(const [candidateKey,candidate] of this.readCache){
   if(candidate.at<oldestAt){oldestAt=candidate.at;oldestKey=candidateKey}
  }
  if(oldestKey===null)break;
  const evicted=this.readCache.get(oldestKey);
  this.readCacheBytes-=evicted.data.length;
  this.readCache.delete(oldestKey);
 }
},
getCachedRead(path,position,length){
 const key=this.cacheKey(path);
 const cached=this.readCache.get(key);
 if(!cached)return null;
 if(cached.expires<Date.now()){
  this.readCacheBytes-=cached.data.length;
  this.readCache.delete(key);
  return null;
 }
 const end=position+length;
 if(position<cached.start||end>cached.start+cached.data.length)return null;
 cached.at=Date.now();
 const begin=position-cached.start;
 return cached.data.subarray(begin,begin+length);
},
isReadOnlyFlags(flags){return (Number(flags)&3)===0},
leaseReadHandle(path){
 const key=this.cacheKey(path);
 const item=this.readHandleCache.get(key);
 if(!item)return null;
 item.refs++;
 item.lastUsed=Date.now();
 return item;
},
cacheReadHandle(path,handle,size){
 const key=this.cacheKey(path);
 const item={handle,size:Number(size)||0,refs:1,lastUsed:Date.now()};
 this.readHandleCache.set(key,item);
 if(this.readHandleCache.size>this.readHandleCacheMax){
  let evictKey=null,evictItem=null;
  for(const [candidateKey,candidate] of this.readHandleCache){
   if(candidateKey===key||candidate.refs>0)continue;
   if(!evictItem||candidate.lastUsed<evictItem.lastUsed){
    evictKey=candidateKey;
    evictItem=candidate;
   }
  }
  if(evictItem){
   this.readHandleCache.delete(evictKey);
   try{this.rpc("close",{handle:evictItem.handle})}
   catch(e){console.warn("REMOTEFS leased handle eviction failed",e)}
  }
 }
 return item;
},
releaseReadHandle(path){
 const item=this.readHandleCache.get(this.cacheKey(path));
 if(!item)return false;
 item.refs=Math.max(0,item.refs-1);
 item.lastUsed=Date.now();
 return true;
},
createNode(parent,name,mode,dev,remotePath,meta){
 const node=FS.createNode(parent,name,mode,dev);
 node.remotePath=remotePath??this.join(parent,name);
 const m=meta?this.cacheMeta(node.remotePath,meta):null;
 node.remoteSize=m&&m.size||0;
 node.remoteMtime=m&&m.mtimeMs||Date.now();
 node.node_ops=this.node_ops;
 node.stream_ops=FS.isDir(mode)?this.dir_stream_ops:this.stream_ops;
 return node;
},
mount(mount){return this.createNode(null,"/",16895,0,"",{directory:true,size:0,mtimeMs:Date.now()})},
statNode(node){
 const r=this.statPath(node.remotePath);
 node.remoteSize=r.size||0;
 node.remoteMtime=r.mtimeMs||Date.now();
 return r;
},
flushWrite(stream,durable){
 if(stream.remoteWriteTimer){
  clearTimeout(stream.remoteWriteTimer);
  stream.remoteWriteTimer=null;
 }
 const pending=stream.remotePendingWrite;
 if(pending){
  const r=this.rpc("write",{handle:stream.remoteHandle,position:pending.start},pending.data).header;
  if((r.bytesWritten||0)!==pending.data.length)throw new FS.ErrnoError(29);
  stream.remotePendingWrite=null;
  stream.remoteReadWindow=null;
  stream.remoteDirty=true;
  this.dropReadCache(stream.node.remotePath);
 }
 if(durable&&stream.remoteDirty&&stream.remoteHandle!==undefined){
  this.rpc("flush",{handle:stream.remoteHandle});
  stream.remoteDirty=false;
 }
},
scheduleWriteFlush(stream){
 if(stream.remoteWriteTimer)clearTimeout(stream.remoteWriteTimer);
 stream.remoteWriteTimer=setTimeout(()=>{
  stream.remoteWriteTimer=null;
  if(!stream.remotePendingWrite)return;
  try{REMOTEFS.flushWrite(stream,false)}
  catch(e){console.error("REMOTEFS background write flush failed",e)}
 },this.writeFlushMs);
},
bufferWrite(stream,bytes,position){
 const pending=stream.remotePendingWrite;
 if(pending){
  const newStart=Math.min(pending.start,position);
  const newEnd=Math.max(pending.start+pending.data.length,position+bytes.length);
  const touches=position<=pending.start+pending.data.length&&position+bytes.length>=pending.start;
  if(touches&&newEnd-newStart<=this.writeBufferMax){
   const merged=new Uint8Array(newEnd-newStart);
   merged.set(pending.data,pending.start-newStart);
   merged.set(bytes,position-newStart);
   stream.remotePendingWrite={start:newStart,data:merged};
   this.scheduleWriteFlush(stream);
   return bytes.length;
  }
  this.flushWrite(stream,false);
 }
 if(bytes.length>this.writeBufferMax){
  const r=this.rpc("write",{handle:stream.remoteHandle,position},bytes).header;
  stream.remoteDirty=true;
  this.dropReadCache(stream.node.remotePath);
  return r.bytesWritten||0;
 }
 stream.remotePendingWrite={start:position,data:bytes.slice()};
 this.scheduleWriteFlush(stream);
 return bytes.length;
},
node_ops:{
 getattr(node){
  if(node.remotePath===""){
   const when=new Date();
   return {dev:1,ino:node.id,mode:node.mode,nlink:1,uid:0,gid:0,rdev:node.rdev,size:4096,atime:when,mtime:when,ctime:when,blksize:4096,blocks:1};
  }
  const s=REMOTEFS.statNode(node);
  const size=s.directory?4096:(s.size||0);
  const when=new Date(s.mtimeMs||Date.now());
  return {dev:1,ino:node.id,mode:node.mode,nlink:1,uid:0,gid:0,rdev:node.rdev,size,atime:when,mtime:when,ctime:when,blksize:4096,blocks:Math.ceil(size/4096)};
 },
 setattr(node,attr){
  if(attr.size!==undefined){
   REMOTEFS.rpc("truncate",{path:node.remotePath,size:attr.size});
   node.remoteSize=attr.size;
   REMOTEFS.invalidateCaches(node.remotePath);
  }
  if(attr.mode!==undefined)node.mode=attr.mode;
  if(attr.mtime!==undefined)node.remoteMtime=+attr.mtime;
 },
 lookup(parent,name){
  const remotePath=REMOTEFS.join(parent,name);
  const listed=REMOTEFS.findCachedDirEntry(parent.remotePath||"",name);
  const s=listed?REMOTEFS.cacheMeta(remotePath,listed):REMOTEFS.statPath(remotePath);
  const mode=(s.directory?16384:32768)|511;
  return REMOTEFS.createNode(parent,name,mode,0,remotePath,s);
 },
 mknod(parent,name,mode,dev){
  const remotePath=REMOTEFS.join(parent,name);
  if(FS.isDir(mode))REMOTEFS.rpc("mkdir",{path:remotePath});
  else REMOTEFS.rpc("create",{path:remotePath});
  REMOTEFS.invalidateCaches();
  return REMOTEFS.createNode(parent,name,mode,dev,remotePath,{directory:FS.isDir(mode),size:0,mtimeMs:Date.now()});
 },
 rename(oldNode,newDir,newName){
  const oldPath=oldNode.remotePath;
  const newPath=REMOTEFS.join(newDir,newName);
  REMOTEFS.rpc("rename",{oldPath,newPath});
  REMOTEFS.invalidateCaches(oldPath);
  REMOTEFS.invalidateCaches(newPath);
  FS.hashRemoveNode(oldNode);
  oldNode.name=newName;
  oldNode.parent=newDir;
  oldNode.remotePath=newPath;
  FS.hashAddNode(oldNode);
 },
 unlink(parent,name){
  const path=REMOTEFS.join(parent,name);
  REMOTEFS.rpc("unlink",{path});
  REMOTEFS.invalidateCaches(path);
  try{FS.hashRemoveNode(FS.lookupNode(parent,name))}catch(e){}
 },
 rmdir(parent,name){
  const path=REMOTEFS.join(parent,name);
  REMOTEFS.rpc("rmdir",{path});
  REMOTEFS.invalidateCaches(path);
  try{FS.hashRemoveNode(FS.lookupNode(parent,name))}catch(e){}
 },
 readdir(node){
  if(node.remotePath==="")return [".",".."];
  const entries=REMOTEFS.listPath(node.remotePath);
  return [".","..",...entries.map(e=>e.name)];
 },
 symlink(){throw new FS.ErrnoError(58)},
 readlink(){throw new FS.ErrnoError(58)}
},
dir_stream_ops:{
 llseek(stream,offset,whence){
  let position=offset;
  if(whence===1)position+=stream.position;
  if(position<0)throw new FS.ErrnoError(28);
  return position;
 }
},
stream_ops:{
 open(stream){
  const readOnly=REMOTEFS.isReadOnlyFlags(stream.flags);
  const leased=readOnly?REMOTEFS.leaseReadHandle(stream.node.remotePath):null;
  let size;
  if(leased){
   stream.remoteHandle=leased.handle;
   stream.remoteLeasedRead=true;
   size=leased.size;
  }else{
   const r=REMOTEFS.rpc("open",{path:stream.node.remotePath,flags:stream.flags}).header;
   stream.remoteHandle=r.handle;
   size=r.size||0;
   if(readOnly){
    REMOTEFS.cacheReadHandle(stream.node.remotePath,r.handle,size);
    stream.remoteLeasedRead=true;
   }
  }
  stream.node.remoteSize=Math.max(stream.node.remoteSize||0,size||0);
  stream.remoteReadWindow=null;
  stream.remoteReadAhead=REMOTEFS.readAheadMin;
  stream.remoteLastReadEnd=null;
  stream.remotePendingWrite=null;
  stream.remoteWriteTimer=null;
  stream.remoteDirty=false;
  REMOTEFS.cacheMeta(stream.node.remotePath,{directory:false,size:size||0,mtimeMs:stream.node.remoteMtime||Date.now()});
 },
 close(stream){
  if(stream.remoteHandle!==undefined){
   REMOTEFS.flushWrite(stream,true);
   if(stream.remoteLeasedRead){
    REMOTEFS.releaseReadHandle(stream.node.remotePath);
   }else{
    REMOTEFS.rpc("close",{handle:stream.remoteHandle});
   }
   delete stream.remoteHandle;
  }
 },
 read(stream,buffer,offset,length,position){
  if(!length)return 0;
  if(stream.remotePendingWrite)REMOTEFS.flushWrite(stream,false);
  const knownSize=Number(stream.node.remoteSize)||0;
  if(knownSize>=0&&position>=knownSize)return 0;
  const allowed=knownSize>position?Math.min(length,knownSize-position):length;
  const global=REMOTEFS.getCachedRead(stream.node.remotePath,position,allowed);
  if(global){
   buffer.set(global,offset);
   stream.remoteLastReadEnd=position+global.length;
   return global.length;
  }
  const window=stream.remoteReadWindow;
  if(window&&position>=window.start&&position+allowed<=window.start+window.data.length){
   const begin=position-window.start;
   buffer.set(window.data.subarray(begin,begin+allowed),offset);
   stream.remoteLastReadEnd=position+allowed;
   return allowed;
  }
  const sequential=stream.remoteLastReadEnd===position;
  stream.remoteReadAhead=sequential
   ?Math.min(REMOTEFS.readAheadMax,Math.max(REMOTEFS.readAheadMin,(stream.remoteReadAhead||REMOTEFS.readAheadMin)*2))
   :REMOTEFS.readAheadMin;
  const remaining=knownSize>position?knownSize-position:REMOTEFS.readAheadMax;
  const fetchLength=Math.max(allowed,Math.min(remaining,stream.remoteReadAhead));
  const r=REMOTEFS.rpc("read",{handle:stream.remoteHandle,length:fetchLength,position});
  const data=r.payload;
  stream.remoteReadWindow={start:position,data};
  REMOTEFS.cacheRead(stream.node.remotePath,position,data,knownSize,stream.node.remoteMtime);
  const bytesRead=Math.min(allowed,r.header.bytesRead||data.length);
  if(bytesRead>0)buffer.set(data.subarray(0,bytesRead),offset);
  stream.remoteLastReadEnd=position+bytesRead;
  return bytesRead;
 },
 write(stream,buffer,offset,length,position){
  if(!length)return 0;
  const bytes=buffer.slice(offset,offset+length);
  const written=REMOTEFS.bufferWrite(stream,bytes,position);
  stream.remoteReadWindow=null;
  stream.remoteDirty=true;
  REMOTEFS.dropReadCache(stream.node.remotePath);
  stream.node.remoteSize=Math.max(stream.node.remoteSize||0,position+written);
  stream.node.remoteMtime=Date.now();
  REMOTEFS.cacheMeta(stream.node.remotePath,{directory:false,size:stream.node.remoteSize,mtimeMs:stream.node.remoteMtime});
  return written;
 },
 fsync(stream){
  REMOTEFS.flushWrite(stream,true);
  return 0;
 },
 llseek(stream,offset,whence){
  let position=offset;
  if(whence===1)position+=stream.position;
  else if(whence===2){
   const s=REMOTEFS.statNode(stream.node);
   position+=(s.size||0);
  }
  if(position<0)throw new FS.ErrnoError(28);
  return position;
 }
}
};
REMOTEFS.prewarmBridge();
