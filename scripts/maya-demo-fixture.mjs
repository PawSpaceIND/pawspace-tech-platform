// Two fixed informational audio fixtures. No text injection, phone API, or booking confirmation.
import {execFileSync} from 'node:child_process';
export const scenarioCode=String(process.env.MAYA_DEMO_SCENARIO||'').trim();
const scenarios={
 payment:'For grooming my dog Bruno, can I pay after service using cash or UPI?',
 rescheduling:'What is the process for rescheduling grooming for my dog Bruno?'
};
if(!Object.hasOwn(scenarios,scenarioCode))throw Error('Explicit fixed Maya informational scenario required');
export const SPOKEN_INFO_EXPECTED=scenarioCode==='payment'?/(?=.*grooming)(?=.*bruno)(?=.*pay)/i:/(?=.*grooming)(?=.*bruno)(?=.*reschedul)/i;
export function syntheticInfoAudio(execute=execFileSync){
 const wav=execute('espeak-ng',['--stdout','-s','150',scenarios[scenarioCode]],{maxBuffer:2*1024*1024,timeout:10000});
 const pcm=execute('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:wav,maxBuffer:1024*1024,timeout:10000});
 if(!Buffer.isBuffer(pcm)||pcm.length<1000||pcm.length>960000)throw Error('Synthetic fixture audio is invalid');
 return pcm;
}
