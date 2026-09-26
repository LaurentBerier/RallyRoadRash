// Recovery is evaluated only on reset, never in the per-frame physics loop.
const wrap=(s,L)=>(s%L+L)%L;

export function rocketRecoveryTarget(hitS, mine, attacker, attackerS, L) {
  if(!attacker || attacker.finished || !mine || !Number.isFinite(attackerS))return hitS;
  const ahead=attacker.liveS-mine.liveS;
  // Never reward a hit from a lapped car, or transport a victim a whole sector.
  if(ahead<=26 || ahead>100)return hitS;
  const advance=wrap(attackerS-hitS+L/2,L)-L/2;
  if(advance<=28)return hitS;
  return wrap(hitS+Math.min(24,Math.max(0,advance-28)*.55),L);
}

export function safeRecoveryS({target,tracker,id,spline,jumps=[],terrain,colliders=[]}) {
  const L=spline.length, from=tracker.lastSlotOf(id).s;
  const next=tracker.nextSlotOf(id);
  const span=wrap(next.s-from,L)||L;
  const limit=Math.max(3,span-Math.max(8,(next.r||0)+4));
  const relative=wrap(target-from+L/2,L)-L/2;
  const desired=Math.min(Math.max(3,relative),limit);
  const p={},d={};
  const safe=(s)=>{
    spline.posAt(s,p);
    for(const gate of next.entries||[]){
      if(Math.hypot(p.x-gate.x,p.z-gate.z)<gate.r+3)return false;
    }
    // A full launch/landing corridor is reserved, including contiguous jumps.
    for(const j of jumps){
      const start=j.s-j.len-22;
      const length=j.len+22+Math.max(j.gap||0,(j.top||0)+(j.down||0),j.kind==='drop'?30:16)+14;
      if(wrap(s-start,L)<length)return false;
    }
    let prevH=null;
    for(const ds of [-4,0,4,10,18]){
      spline.posAt(wrap(s+ds,L),p);spline.dirAt(wrap(s+ds,L),d);
      const h=terrain.heightAt(p.x,p.z);
      if(!Number.isFinite(h)||Math.abs(h-p.y)>2.5)return false;
      if(prevH!==null&&Math.abs(h-prevH)>2)return false;
      prevH=h;
      for(const side of [-1,1]){
        const edge=terrain.heightAt(p.x+d.z*side*1.8,p.z-d.x*side*1.8);
        if(!Number.isFinite(edge)||Math.abs(edge-h)>1)return false;
      }
      for(const c of colliders){
        if(Math.hypot(p.x-c.x,p.z-c.z)<(c.r||0)+2.5)return false;
      }
    }
    return true;
  };
  // Prefer the closest safe stretch behind the target. Only search forward
  // when necessary, and never cross the pending checkpoint or finish line.
  for(let a=desired;a>=3;a-=2){const s=wrap(from+a,L);if(safe(s))return s;}
  for(let a=desired+2;a<Math.min(limit,desired+8);a+=2){const s=wrap(from+a,L);if(safe(s))return s;}
  // A checkpoint can itself sit on a lip. Retreat to its approach instead of
  // dropping into a hole. Keeping checkpoint state is safe when moving BACK.
  for(let a=3;a<Math.min(L,250);a+=2){const s=wrap(from-a,L);if(safe(s))return s;}
  return null;
}
