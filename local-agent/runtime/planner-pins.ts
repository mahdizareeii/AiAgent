/** Official b11429 planners, extracted only after verifying the complete release
 * archive SHA-256. These identities grant no execution or hardware-fit proof. */
export const ALLOCATION_PLANNER_PINS=Object.freeze({
  'darwin-arm64':Object.freeze({id:'metal',executable:'metal/llama-fit-params',libraryDirectory:'metal',sha256:'d28f5116bfc500b9a40a0d764cfb0a274a7d17c0ae5ae5d18bd313225ffdae29'}),
  'linux-x64':Object.freeze({id:'cpu',executable:'cpu/llama-fit-params',libraryDirectory:'cpu',sha256:'b2ad073a0c093706e5dfdfe2c9864d199ed921e49ea0383a7d0013e2ad8a81c8'}),
  'win32-x64':Object.freeze({id:'cpu',executable:'cpu/llama-fit-params.exe',libraryDirectory:'cpu',sha256:'c2bf85d263a04a73ed4af00e08a42296daac5a33255e31952e133b474848a494'}),
});
export function allocationPlannerPin(target:string){return ALLOCATION_PLANNER_PINS[target as keyof typeof ALLOCATION_PLANNER_PINS];}
export function allocationPlannerDescriptor(target:string){const pin=allocationPlannerPin(target);if(!pin)throw new Error(`No pinned allocation planner for ${target}.`);return {id:pin.id,executable:pin.executable,libraryDirectory:pin.libraryDirectory,arguments:[] as string[]};}
export function matchesAllocationPlanner(value:unknown,target:string,files:readonly {path:string;sha256:string}[]):boolean{
  const pin=allocationPlannerPin(target);if(!pin||!value||typeof value!=='object')return false;
  const planner=value as Record<string,unknown>;
  return planner.id===pin.id&&planner.executable===pin.executable&&planner.libraryDirectory===pin.libraryDirectory&&JSON.stringify(planner.arguments??[])==='[]'
    &&files.filter(file=>file.path===pin.executable).length===1&&files.some(file=>file.path===pin.executable&&file.sha256===pin.sha256);
}
