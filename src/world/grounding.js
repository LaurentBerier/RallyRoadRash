// Fit a roadside banner to both shoulders and the ground between them.
export function gateTerrainProfile(terrain,spline,checkpoint,span) {
  const baseY=terrain.heightAt(checkpoint.x,checkpoint.z);
  const l=spline.offsetPoint(checkpoint.s,-span*.5,{}),r=spline.offsetPoint(checkpoint.s,span*.5,{});
  const left=terrain.heightAt(l.x,l.z)-baseY,right=terrain.heightAt(r.x,r.z)-baseY;
  let lift=0;
  for(let j=0;j<=24;j++) {
    const t=j/24,q=spline.offsetPoint(checkpoint.s,(t-.5)*span,{});
    lift=Math.max(lift,terrain.heightAt(q.x,q.z)-baseY-(left+(right-left)*t));
  }
  return {left,right,lift};
}
