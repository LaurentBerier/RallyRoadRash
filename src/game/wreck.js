// Direct hits have a readable crash beat, followed by a bounded recovery.
export const WRECK_MIN=2.9, WRECK_MAX=4.0;
export const WRECK_CTL=Object.freeze({throttle:0,steer:0,brake:0,handbrake:0,roll:0,boost:false});
export function beginWreck(v,s,attacker=null){if(v.wrecked)return false;v.wrecked=true;v.wreckAge=0;v.wreckGround=0;v.wreckS=s;v.wreckAttacker=attacker;return true;}
export function tickWreck(v,dt){
 if(!v.wrecked)return false;
 v.wreckAge+=dt;v.wreckGround=v.contacts>0?v.wreckGround+dt:0;
 return v.wreckAge>=WRECK_MAX || (v.wreckAge>=WRECK_MIN&&v.wreckGround>=.25);
}
