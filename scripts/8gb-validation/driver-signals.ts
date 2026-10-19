export type DriverSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
export interface DriverInterruption { signal:DriverSignal; caughtAt:string; exitCode:number; }

/** A signal requests existing owned cleanup; it never exits the controller or
 * invents child completion. Repeated signals retain the first request. */
export function installDriverInterruption(source:Pick<NodeJS.Process,'on'|'off'>=process) {
  let first:Readonly<DriverInterruption>|null=null, stop:((value:Readonly<DriverInterruption>)=>void)|null=null;
  const codes={SIGINT:130,SIGTERM:143,SIGHUP:129} as const;
  const listeners=(Object.keys(codes) as DriverSignal[]).map(signal=>{
    const listener=()=>{if(first)return;first=Object.freeze({signal,caughtAt:new Date().toISOString(),exitCode:codes[signal]});stop?.(first);};
    source.on(signal,listener);return {signal,listener};
  });
  return {
    get first(){return first;},
    bindStop(callback:(value:Readonly<DriverInterruption>)=>void){
      if(stop)throw new Error('A signal cleanup owner is already bound.');stop=callback;
      if(first)callback(first);
      return ()=>{if(stop===callback)stop=null;};
    },
    throwIfInterrupted(){if(first)throw new Error(`Driver interrupted by ${first.signal}; no further controller may start.`);},
    dispose(){for(const{signal,listener}of listeners)source.off(signal,listener);stop=null;},
  };
}
