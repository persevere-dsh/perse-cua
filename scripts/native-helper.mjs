/** Build and inspect the existing macOS CUA helper without starting desktop control. */
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

export const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const nativeRoot=join(repositoryRoot,'packages/perse-cua/native');
const architectures=new Map([['arm64','arm64'],['x64','x86_64']]);
export async function sourceDigest(){
  const hash=createHash('sha256');
  async function add(relative){
    const absolute=join(nativeRoot,relative),stat=await lstat(absolute);
    if(stat.isSymbolicLink())throw Error('Native source must not contain symlinks');
    if(stat.isDirectory())for(const name of (await readdir(absolute)).sort())await add(join(relative,name));
    else if(stat.isFile()){hash.update(relative+'\0');hash.update(await readFile(absolute));hash.update('\0');}
    else throw Error('Unsupported native source entry: '+relative);
  }
  for(const relative of ['Package.swift','protocol.schema.json','Sources'])await add(relative);
  return hash.digest('hex');
}
/** Check artifact bytes and the source digest without macOS signing tools. */
export async function verifyPortable({binary,arch,manifest}){
  if(!architectures.has(arch))throw Error('Unsupported target architecture');
  const info=await lstat(binary);
  if(!info.isFile()||info.isSymbolicLink())throw Error('Helper must be a regular file');
  const bytes=await readFile(binary),sha256=createHash('sha256').update(bytes).digest('hex');
  const expected=JSON.parse(await readFile(manifest,'utf8'));
  if(expected.format!=='perse-cua-helper-v1'||expected.sha256!==sha256||expected.arch!==arch||expected.size!==bytes.length||expected.sourceSha256!==await sourceDigest())throw Error('Helper manifest does not match packaged bytes and source');
  return expected;
}
const run=(command,args,timeout=30000)=>{try{return execFileSync(command,args,{encoding:'utf8',timeout,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']}).trim();}catch(error){throw Error(`${command} failed (exit ${error.status}, signal ${error.signal}):\n${String(error.stderr||error.stdout||error.message).slice(-12000)}`);}};

/** Parse explicit staging paths; never choose a user's installed application by default. */
export function argumentsFor(argv,kind){
  const options={arch:process.arch,requireDeveloperId:false,signIdentity:'-'};
  const values=new Set(kind==='build'?['arch','output','sign-identity']:['arch','binary','manifest']);
  for(let i=0;i<argv.length;i++){
    const name=argv[i].replace(/^--/,'');
    if(argv[i]==='--require-developer-id'){options.requireDeveloperId=true;continue;}
    if(!argv[i].startsWith('--')||!values.has(name)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('Unsupported or missing argument: '+argv[i]);
    options[name==='sign-identity'?'signIdentity':name]=argv[++i];
  }
  if(!architectures.has(options.arch))throw Error('Expected --arch arm64 or x64');
  const required=kind==='build'?'output':'binary';
  if(!options[required])throw Error('Required --'+required+' absolute staging path');
  for(const name of ['output','binary','manifest'])if(options[name]&&resolve(options[name])!==options[name])throw Error('--'+name+' must be an absolute path');
  if(kind==='build'&&options.requireDeveloperId&&options.signIdentity==='-')throw Error('Developer ID verification requires an explicit signing identity');
  return options;
}

/** Inspect bytes, Mach-O architecture and signature. Does not execute the helper or request permissions. */
export async function verifyHelper({binary,arch,manifest,requireDeveloperId=false}){
  if(process.platform!=='darwin')throw Error('CUA helper verification requires macOS');
  if(!architectures.has(arch))throw Error('Unsupported target architecture');
  const info=await lstat(binary);
  if(!info.isFile()||info.isSymbolicLink()||!(info.mode&0o111))throw Error('Helper must be a regular executable file');
  const bytes=await readFile(binary),sha256=createHash('sha256').update(bytes).digest('hex');
  const found=run('/usr/bin/lipo',['-archs',binary]).split(/\s+/);
  if(found.length!==1||found[0]!==architectures.get(arch))throw Error('Helper architecture does not match '+arch);
  run('/usr/bin/codesign',['--verify','--strict',binary]);
  // codesign writes signature details to stderr even on success.
  const details=spawnSync('/usr/bin/codesign',['--display','--verbose=4',binary],{encoding:'utf8',timeout:30000});
  if(details.error||details.status!==0)throw Error('Cannot inspect helper signature');
  const developerId=/^Authority=Developer ID Application:/m.test(details.stderr);
  const minimum=run('/usr/bin/otool',['-l',binary]).match(/cmd LC_BUILD_VERSION[\s\S]*?\bminos (\d+(?:\.\d+)+)/)?.[1];
  if(!minimum||Number(minimum.split('.')[0])>14)throw Error('Helper deployment target is incompatible with macOS 14');
  if(requireDeveloperId&&!developerId)throw Error('Helper is not signed with Developer ID Application');
  if(manifest)await verifyPortable({binary,arch,manifest});
  return {format:'perse-cua-helper-v1',arch,sha256,size:bytes.length,minimum_macos:minimum,signature:developerId?'developer-id':'local',gui_verified:false};
}

/** Compile in a staging-owned scratch directory, sign, verify, then publish the payload atomically. */
export async function buildHelper(options){
  if(process.platform!=='darwin')throw Error('CUA helper build requires macOS');
  const {arch,output,signIdentity,requireDeveloperId}=options;
  const target=join(output,'darwin-'+arch),scratch=await mkdtemp(join(tmpdir(),'wuzhimiao-cua-build-'));
  await mkdir(target,{recursive:true});
  const temporary=join(target,'.dsh-cua-native-'+randomUUID());
  try{
    run('/usr/bin/xcrun',['swift','build','--package-path',nativeRoot,'--scratch-path',scratch,'--configuration','release','--product','dsh-cua-native','--arch',architectures.get(arch)],300000);
    await copyFile(join(scratch,'release/dsh-cua-native'),temporary);await chmod(temporary,0o755);
    run('/usr/bin/codesign',['--force','--sign',signIdentity,...(signIdentity==='-'?[]:['--timestamp','--options','runtime']),temporary]);
    const result={...await verifyHelper({binary:temporary,arch,requireDeveloperId}),sourceSha256:await sourceDigest()};
    const binary=join(target,'dsh-cua-native');await rename(temporary,binary);
    await writeFile(join(target,'manifest.json'),JSON.stringify(result,null,2)+'\n');
    return {...result,binary,manifest:join(target,'manifest.json')};
  }finally{await rm(temporary,{force:true});await rm(scratch,{recursive:true,force:true});}
}
