let attempts=0;
globalThis.fetch=async()=>{attempts++;throw new Error('P1 local fixture forbids external transport');};
process.on('exit',()=>{console.log('P1 external fetch attempts: '+attempts);if(attempts)process.exitCode=1;});
