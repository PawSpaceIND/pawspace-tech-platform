// Generate only the fixed informational fixture; never stream an arbitrary local file.
import {execFileSync} from 'node:child_process';
import {SPOKEN_INFO_TEXT} from './voice-spoken-fixtures.mjs';
export function syntheticInfoAudio(execute=execFileSync){
 const wav=execute('espeak-ng',['--stdout','-s','150',SPOKEN_INFO_TEXT],{maxBuffer:2*1024*1024,timeout:10000});
 const pcm=execute('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:wav,maxBuffer:1024*1024,timeout:10000});
 if(!Buffer.isBuffer(pcm)||pcm.length<1000||pcm.length>960000)throw Error('Synthetic fixture audio is invalid');
 return pcm;
}
