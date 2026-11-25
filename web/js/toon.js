import * as THREE from 'three';

// Kreslený styl („jako z animovaného seriálu“): scéna se vykreslí do textury a přes ni se dá filtr –
// tmavé obrysy podle skoků v hloubce a v barvě, sytější barvy odstíněné do několika ploch
// (cel shading) a teplý nádech. Zdálky obrysy slábnou, ať krajina nezčerná.

export function createToon(renderer, coarse) {
  let target = null, on = false;
  const size = new THREE.Vector2();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: null }, tDepth: { value: null }, res: { value: new THREE.Vector2(1, 1) },
      near: { value: 1 }, far: { value: 20000 }, px: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform sampler2D tColor, tDepth; uniform vec2 res; uniform float near, far, px;
      varying vec2 vUv;
      float vz(vec2 uv){ return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, near, far); }
      float lum(vec3 c){ return dot(c, vec3(.299, .587, .114)); }
      void main(){
        vec2 o = px * 1.25 / res;
        vec3 c = texture2D(tColor, vUv).rgb;
        float d = vz(vUv);
        // obrys: relativní skok hloubky ve 4 směrech + hrana v jasu
        float dl = vz(vUv - vec2(o.x, 0.)), dr = vz(vUv + vec2(o.x, 0.)), du = vz(vUv + vec2(0., o.y)), dd = vz(vUv - vec2(0., o.y));
        float jump = max(max(abs(dl - d), abs(dr - d)), max(abs(du - d), abs(dd - d))) / d;
        float ed = smoothstep(.012, .03, jump);
        float l0 = lum(c);
        float ll = lum(texture2D(tColor, vUv - vec2(o.x, 0.)).rgb), lr = lum(texture2D(tColor, vUv + vec2(o.x, 0.)).rgb);
        float lu = lum(texture2D(tColor, vUv + vec2(0., o.y)).rgb), ld = lum(texture2D(tColor, vUv - vec2(0., o.y)).rgb);
        float ec = smoothstep(.10, .22, length(vec2(lr - ll, lu - ld)));
        float edge = max(ed, ec * .7) * (1. - smoothstep(900., 3500., d));
        if (d > far * .98) edge = 0.;              // obloha bez obrysů
        // barvy: sytost + odstupňovaný jas (několik ploch), teplý nádech
        float L = max(l0, 1e-4);
        vec3 s = mix(vec3(L), c, 1.22);
        float q = floor(pow(L, .8) * 5. + .55) / 5.;
        s *= mix(1., pow(max(q, .04), 1.25) / pow(L, 1.), .55);
        s = s * vec3(1.05, .99, .9) + vec3(.014, .01, .004);
        vec3 ink = vec3(.10, .07, .06);
        gl_FragColor = vec4(mix(s, ink, edge * .9), 1.);
        #include <colorspace_fragment>
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const qScene = new THREE.Scene(); qScene.add(quad);
  const qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function ensure() {
    renderer.getDrawingBufferSize(size);
    if (target && target.width === size.x && target.height === size.y) return;
    target?.dispose();
    target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType, samples: coarse ? 0 : 4, colorSpace: THREE.LinearSRGBColorSpace,
    });
    target.depthTexture = new THREE.DepthTexture(size.x, size.y);
    target.depthTexture.type = THREE.UnsignedIntType;
    mat.uniforms.res.value.set(size.x, size.y);
    mat.uniforms.px.value = Math.max(1, renderer.getPixelRatio());
  }
  return {
    get on() { return on; },
    set(v) { on = v; if (!v && target) { target.dispose(); target = null; } },
    render(scene, camera) {
      ensure();
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      mat.uniforms.tColor.value = target.texture;
      mat.uniforms.tDepth.value = target.depthTexture;
      mat.uniforms.near.value = camera.near;
      mat.uniforms.far.value = camera.far;
      renderer.render(qScene, qCam);
    },
  };
}
