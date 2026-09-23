import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Use the original scene depth, so the displaced terrain and instanced rocks
// participate without a second geometry/normal render. High tiers only.
export class ContactAOPass extends ShaderPass {
  constructor(camera) {
    super({
      uniforms:{tDiffuse:{value:null},tDepth:{value:null},uInvProjection:{value:new THREE.Matrix4()},
        uSize:{value:new THREE.Vector2(1,1)},uProjectionScale:{value:1}},
      vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader:`
        uniform sampler2D tDiffuse,tDepth;
        uniform mat4 uInvProjection;
        uniform vec2 uSize;
        uniform float uProjectionScale;
        varying vec2 vUv;
        vec3 viewPosition(vec2 uv,float depth){
          vec4 p=uInvProjection*vec4(uv*2.-1.,depth*2.-1.,1.);
          return p.xyz/p.w;
        }
        void main(){
          vec4 color=texture2D(tDiffuse,vUv);
          float depth=texture2D(tDepth,vUv).r;
          vec3 p=viewPosition(vUv,depth);
          vec3 n=normalize(cross(dFdx(p),dFdy(p)));
          if(dot(n,-p)<0.)n=-n;
          if(depth<.99999 && -p.z<140.) {
            float radius=clamp(.85*uProjectionScale*uSize.y/max(-p.z,.2),2.,26.);
            float occ=0.;
            for(int i=0;i<8;i++) {
              float a=(float(i)+.25)*.78539816;
              vec2 direction=vec2(cos(a),sin(a));
              for(int j=1;j<=3;j++) {
                vec2 uv=vUv+direction*radius*(float(j)/3.)/uSize;
                if(uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.)continue;
                float d=texture2D(tDepth,uv).r;
                vec3 delta=viewPosition(uv,d)-p;
                float len=length(delta);
                occ+=max(0.,dot(n,delta)/max(len,.001)-.10)*(1.-smoothstep(.15,1.5,len));
              }
            }
            float fade=1.-smoothstep(70.,140.,-p.z);
            color.rgb*=1.-min(.32,occ*.12)*fade;
          }
          gl_FragColor=color;
        }`
    });
    this.camera=camera;
    this.material.depthTest=false;this.material.depthWrite=false;
  }
  setSize(w,h){this.uniforms.uSize.value.set(w,h);}
  render(renderer,writeBuffer,readBuffer,...rest){
    this.uniforms.tDepth.value=readBuffer.depthTexture;
    this.uniforms.uInvProjection.value.copy(this.camera.projectionMatrixInverse);
    this.uniforms.uProjectionScale.value=this.camera.projectionMatrix.elements[5]*.5;
    super.render(renderer,writeBuffer,readBuffer,...rest);
  }
}
