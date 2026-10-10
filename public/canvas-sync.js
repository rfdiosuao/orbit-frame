const equal=(a,b)=> {
  if(a===b)return true;
  if(a==null || b==null || typeof a!==typeof b)return false;
  if(typeof a!=='object')return false;
  if(Array.isArray(a) || Array.isArray(b))return Array.isArray(a) && Array.isArray(b) && a.length===b.length && a.every((v,i)=>equal(v,b[i]));
  const keys=Object.keys(a),other=Object.keys(b);return keys.length===other.length && keys.every(k=>Object.hasOwn(b,k) && equal(a[k],b[k]));
};
const conflict=Symbol('conflict');
function mergeValue(base,local,remote) {
  if(equal(local,remote) || equal(remote,base))return structuredClone(local);
  if(equal(local,base))return structuredClone(remote);
  if(base && local && remote && !Array.isArray(base) && !Array.isArray(local) && !Array.isArray(remote) && typeof base==='object' && typeof local==='object' && typeof remote==='object') {
    const merged={};
    for(const key of new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)])) {
      const value=mergeValue(base[key],local[key],remote[key]);if(value===conflict)return conflict;
      if(value!==undefined)merged[key]=value;
    }
    return merged;
  }
  return conflict;
}
function mergeItems(base,local,remote) {
  const b=new Map(base.map(i=>[i.id,i])),l=new Map(local.map(i=>[i.id,i])),r=new Map(remote.map(i=>[i.id,i])),result=[];
  for(const id of new Set([...local.map(i=>i.id),...remote.map(i=>i.id),...base.map(i=>i.id)])) {
    const item=mergeValue(b.get(id),l.get(id),r.get(id));if(item===conflict)return null;if(item)result.push(item);
  }
  return result;
}
// Merge disjoint edits and task receipts against the last acknowledged server
// document. A conflicting edit to the same value still requires recovery.
export function mergeCanvasDocuments(base,local,remote) {
  if(!base || base.id!==local.id || local.id!==remote.id)return null;
  const cards=mergeItems(base.cards,local.cards,remote.cards),edges=mergeItems(base.edges,local.edges,remote.edges);
  if(!cards || !edges)return null;
  const title=mergeValue(base.title,local.title,remote.title),viewport=mergeValue(base.viewport,local.viewport,remote.viewport);
  if(title===conflict || viewport===conflict)return null;
  return {...remote,title,viewport,cards,edges};
}
