// Kernel membership may include supplementary v1 hierarchies. Only one
// well-formed v2 row supplies membership; preserve its path verbatim.
export function newtestUnifiedControlGroup(text:string):string|null{
  let unified:string|null=null;
  for(const line of text.replace(/\n$/, "").split("\n")){
    const row=/^(0|[1-9][0-9]*):([^:]*):(\/[^\0\r\n]*)$/.exec(line);
    if(!row)return null;
    const [,hierarchy,controllers,group]=row;
    if(hierarchy==="0"){
      if(controllers!==""||unified!==null)return null;
      unified=group!;
    }else if(!/^(?:[a-zA-Z0-9_-]+|name=[a-zA-Z0-9_.-]+)(?:,(?:[a-zA-Z0-9_-]+|name=[a-zA-Z0-9_.-]+))*$/.test(controllers!))return null;
  }
  return unified;
}
// Fixed guest admission only; no caller-selected expected path or override.
export function isNewtestGuestCgroup(text:string):boolean{
  return newtestUnifiedControlGroup(text)==="/system.slice/native-newtest.service";
}
