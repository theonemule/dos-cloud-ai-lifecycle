var REMOTEFS={
nextId:1,
transportSession:"emu-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2),
launchSession:null,
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
 if(headerLength<2||4+headerLength>data.length)throw new Error("invalid remote filesystem response");
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
rpc(op,args,payload){
 if(typeof XMLHttpRequest==="undefined")throw new FS.ErrnoError(58);
 const prepared=this.prepareArgs(args);
 if(!this.launchSession)throw new FS.ErrnoError(2);
 const origin=new URL(self.location.origin);
 const url=origin.origin+"/api/fs?client=emulator&launch="+encodeURIComponent(this.launchSession)+"&session="+encodeURIComponent(this.transportSession);
 const request=this.encodePacket({id:this.nextId++,op,...prepared},payload);
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
 let response;
 try{
  response=this.decodePacket(xhr.response);
 }catch(e){
  console.error("REMOTEFS response decode failed",op,e);
  throw new FS.ErrnoError(29);
 }
 if(!response.header.ok){
  throw new FS.ErrnoError(this.errno[response.header.code]||29);
 }
 return response;
},
join(parent,name){
 const base=parent&&parent.remotePath?parent.remotePath:"";
 return base?base+"/"+name:name;
},
createNode(parent,name,mode,dev,remotePath,meta){
 const node=FS.createNode(parent,name,mode,dev);
 node.remotePath=remotePath??this.join(parent,name);
 node.remoteSize=meta&&meta.size||0;
 node.remoteMtime=meta&&meta.mtimeMs||Date.now();
 node.node_ops=this.node_ops;
 node.stream_ops=FS.isDir(mode)?this.dir_stream_ops:this.stream_ops;
 return node;
},
mount(mount){
 return this.createNode(null,"/",16895,0,"",{directory:true,size:0,mtimeMs:Date.now()});
},
statNode(node){
 const r=this.rpc("stat",{path:node.remotePath}).header;
 node.remoteSize=r.size||0;
 node.remoteMtime=r.mtimeMs||Date.now();
 return r;
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
  }
  if(attr.mode!==undefined)node.mode=attr.mode;
  if(attr.mtime!==undefined)node.remoteMtime=+attr.mtime;
 },
 lookup(parent,name){
  const remotePath=REMOTEFS.join(parent,name);
  const s=REMOTEFS.rpc("stat",{path:remotePath}).header;
  const mode=(s.directory?16384:32768)|511;
  return REMOTEFS.createNode(parent,name,mode,0,remotePath,s);
 },
 mknod(parent,name,mode,dev){
  const remotePath=REMOTEFS.join(parent,name);
  if(FS.isDir(mode))REMOTEFS.rpc("mkdir",{path:remotePath});
  else REMOTEFS.rpc("create",{path:remotePath});
  return REMOTEFS.createNode(parent,name,mode,dev,remotePath,{directory:FS.isDir(mode),size:0,mtimeMs:Date.now()});
 },
 rename(oldNode,newDir,newName){
  const oldPath=oldNode.remotePath;
  const newPath=REMOTEFS.join(newDir,newName);
  REMOTEFS.rpc("rename",{oldPath,newPath});
  FS.hashRemoveNode(oldNode);
  oldNode.name=newName;
  oldNode.parent=newDir;
  oldNode.remotePath=newPath;
  FS.hashAddNode(oldNode);
 },
 unlink(parent,name){
  const path=REMOTEFS.join(parent,name);
  REMOTEFS.rpc("unlink",{path});
  try{FS.hashRemoveNode(FS.lookupNode(parent,name))}catch(e){}
 },
 rmdir(parent,name){
  const path=REMOTEFS.join(parent,name);
  REMOTEFS.rpc("rmdir",{path});
  try{FS.hashRemoveNode(FS.lookupNode(parent,name))}catch(e){}
 },
 readdir(node){
  if(node.remotePath==="")return [".",".."];
  const r=REMOTEFS.rpc("list",{path:node.remotePath}).header;
  return [".","..",...(r.entries||[]).map(e=>e.name)];
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
  const r=REMOTEFS.rpc("open",{path:stream.node.remotePath,flags:stream.flags}).header;
  stream.remoteHandle=r.handle;
  stream.node.remoteSize=Math.max(stream.node.remoteSize||0,r.size||0);
 },
 close(stream){
  if(stream.remoteHandle!==undefined){
   REMOTEFS.rpc("close",{handle:stream.remoteHandle});
   delete stream.remoteHandle;
  }
 },
 read(stream,buffer,offset,length,position){
  if(!length)return 0;
  const r=REMOTEFS.rpc("read",{handle:stream.remoteHandle,length,position});
  buffer.set(r.payload,offset);
  return r.header.bytesRead||0;
 },
 write(stream,buffer,offset,length,position){
  if(!length)return 0;
  const bytes=buffer.slice(offset,offset+length);
  const r=REMOTEFS.rpc("write",{handle:stream.remoteHandle,position},bytes).header;
  stream.node.remoteSize=Math.max(stream.node.remoteSize||0,position+(r.bytesWritten||0));
  stream.node.remoteMtime=Date.now();
  return r.bytesWritten||0;
 },
 llseek(stream,offset,whence){
  let position=offset;
  if(whence===1)position+=stream.position;
  else if(whence===2){
   const s=REMOTEFS.statNode(stream.node);
   position+=(s.size||0);
  }
  if(position<0)throw new FS.ErrnoError(28);
  if(stream.remoteHandle!==undefined)REMOTEFS.rpc("seek",{handle:stream.remoteHandle,offset:position,whence:0});
  return position;
 }
}
};
