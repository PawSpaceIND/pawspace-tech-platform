const DEFAULT_NOISE_FLOOR_RMS=80;
const MIN_THRESHOLD_RMS=160;
const MAX_THRESHOLD_RMS=900;
const NOISE_MULTIPLIER=2.4;
const NOISE_ALPHA=0.08;

const numeric=(value:unknown)=>{const n=Number(String(value??"").trim());return Number.isFinite(n)&&n>0?n:null;};

export type VoiceVadDecision={speech:boolean;rms:number;thresholdRms:number;noiseFloorRms:number;configured:boolean};

export function createAdaptiveVoiceActivityDetector(configuredThreshold?:unknown){
 const fixed=numeric(configuredThreshold);
 let noiseFloor=DEFAULT_NOISE_FLOOR_RMS;
 let frames=0,speechFrames=0,maxRms=0,lastThreshold=fixed??Math.max(MIN_THRESHOLD_RMS,noiseFloor*NOISE_MULTIPLIER);
 return{
  observe(rmsInput:number):VoiceVadDecision{
   const rms=Number.isFinite(rmsInput)?Math.max(0,rmsInput):0;
   const threshold=fixed??Math.max(MIN_THRESHOLD_RMS,Math.min(MAX_THRESHOLD_RMS,noiseFloor*NOISE_MULTIPLIER));
   const speech=rms>=threshold;
   frames++;if(speech)speechFrames++;maxRms=Math.max(maxRms,rms);lastThreshold=threshold;
   // Learn only from frames below the speech boundary. This prevents actual speech from ratcheting the
   // noise estimate upward and making a quiet caller progressively harder to detect.
   if(!fixed&&!speech)noiseFloor=(1-NOISE_ALPHA)*noiseFloor+NOISE_ALPHA*rms;
   return{speech,rms,thresholdRms:Math.round(threshold),noiseFloorRms:Math.round(noiseFloor),configured:Boolean(fixed)};
  },
  snapshot(){return{frames,speechFrames,maxRms:Math.round(maxRms),thresholdRms:Math.round(lastThreshold),noiseFloorRms:Math.round(noiseFloor),configured:Boolean(fixed)};},
 };
}
