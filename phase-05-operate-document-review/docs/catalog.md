# Phase 3 Catalog

Phase 3 contains 15 installed-format MS-DOS shareware packages. Each catalog manifest records its package filename, SHA-256 checksum, source page, install directory, launch command, DOSBox settings, presentation metadata, and capabilities.

The packages are sourced from DOS Games Archive entries that identify the selected downloads as shareware or "Shareware (installed)". The repository does not include Prince of Persia, Carmen Sandiego, Oregon Trail, or other titles for which a redistributable shareware package was not established during this phase.

| Game | Catalog ID | Package | Launch command |
| --- | --- | --- | --- |
| Commander Keen 1 | `keen1` | `keen-box.zip` | `KEEN1WEB.BAT` |
| DOOM | `doom` | `doom-box.zip` | `DOOMWEB.BAT` |
| Wolfenstein 3D | `wolf3d` | `w3d-box.zip` | `W3DWEB.BAT` |
| Duke Nukem | `duke1` | `duke-box.zip` | `DN1WEB.BAT` |
| Duke Nukem 3D | `duke3d` | `dn3d-box.zip` | `DN3DWEB.BAT` |
| Secret Agent | `secret-agent` | `agent-box.zip` | `SAM.BAT` |
| Blake Stone | `blake-stone` | `blake-box.zip` | `BLAKEWEB.BAT` |
| Raptor | `raptor` | `rapt-box.zip` | `RAPTOR.BAT` |
| Rise of the Triad | `rott` | `huntbgin-box.zip` | `ROTTWEB.BAT` |
| Hocus Pocus | `hocus` | `hp-shr.zip` | `HOCUS.BAT` |
| Wacky Wheels | `wacky-wheels` | `wack-box.zip` | `WACKY.BAT` |
| Cosmo's Cosmic Adventure | `cosmo` | `cosmo-box.zip` | `COSWEB.BAT` |
| Terminal Velocity | `terminal-velocity` | `tv-box.zip` | `TVWEB.BAT` |
| Shadow Warrior | `shadow-warrior` | `sw-box.zip` | `SWWEB.BAT` |
| Jazz Jackrabbit | `jazz-jackrabbit` | `jazz-gus.zip` | `JAZZ.BAT` |

## Catalog validation

The automated tests verify for every manifest that:

- the referenced package exists
- its SHA-256 matches the manifest
- the archive contains the declared launch command
- the package passes archive-path validation
- it installs into an isolated user drive
- a metadata-driven launch session can be created
