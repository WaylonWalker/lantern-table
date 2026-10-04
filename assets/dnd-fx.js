/* Lantern Table — D&D gameplay shader pack
 * Original zero-dependency WebGL + CSS material effects.
 * Radiant-inspired architecture (single canvas, DPR cap, visibility pause),
 * but no Radiant runtime or copied shader source.
 */
(() => {
  'use strict';

  const MODES = Object.freeze({
    wet: 1, cold: 2, fire: 3, hot: 4, acid: 5, poison: 6,
    radiant: 7, necrotic: 8, lightning: 9, thunder: 10, force: 11,
    psychic: 12, darkness: 13, web: 14, grease: 15, faerie: 16,
    petrified: 17,
  });

  const SHADER_PRIORITY = [
    'lightning','fire','radiant','necrotic','acid','psychic','force','thunder',
    'cold','hot','poison','darkness','web','wet','grease','faerie','petrified'
  ];
  const MATERIAL_PRIORITY = ['fire','acid','cold','wet','hot','grease','web','petrified'];
  const ENERGY_PRIORITY = ['lightning','radiant','necrotic','force','psychic','poison','faerie','thunder'];
  const LEGACY_SHADER_EFFECTS = new Set(['water','underwater','aurora']);

  let active = [];
  let intensity = 0.35;
  let modeName = 'none';
  let canvas = null;
  let gl = null;
  let program = null;
  let raf = 0;
  let renderLoop = null;
  let started = false;
  let u = {};
  let pointerX = 0.5;
  let pointerY = 0.45;
  let renderPointerX = 0.5;
  let renderPointerY = 0.45;
  let pointerPulse = 0;
  let pointerCssRaf = 0;
  let pointerCssActive = false;

  const root = document.documentElement;
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  function firstActive(priority, effects) {
    return priority.find(name => effects.includes(name)) || '';
  }

  function chooseShader(effects) {
    // Keep the existing Lantern water/underwater/aurora renderer authoritative.
    // The pack handles new gameplay states alongside it.
    // Darkness is a full-page lighting state, so it takes precedence over local scene shaders.
    if (effects.includes('darkness')) return 'darkness';
    return firstActive(SHADER_PRIORITY, effects);
  }

  function applySurfaceChannels(effects, strength) {
    const material = firstActive(MATERIAL_PRIORITY, effects);
    const energy = firstActive(ENERGY_PRIORITY, effects);
    if (material) root.dataset.ltMaterial = material;
    else delete root.dataset.ltMaterial;
    if (energy) root.dataset.ltEnergy = energy;
    else delete root.dataset.ltEnergy;
    root.style.setProperty('--lt-fx-strength', clamp(strength, 0, 1).toFixed(3));
    root.classList.toggle('lt-fx-active', !!(material || energy));
  }

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const msg = gl.getShaderInfoLog(shader) || 'unknown shader compile error';
      gl.deleteShader(shader);
      throw new Error(msg);
    }
    return shader;
  }

  function createRenderer() {
    if (started) return;
    started = true;
    canvas = document.createElement('canvas');
    canvas.id = 'dndFxCanvas';
    canvas.className = 'lt-dnd-fx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
    gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) {
      canvas.remove();
      canvas = null;
      return;
    }

    const vertex = `
      attribute vec2 p;
      void main(){ gl_Position=vec4(p,0.0,1.0); }
    `;

    const fragment = `
      precision mediump float;
      uniform vec2 r;
      uniform float t;
      uniform float m;
      uniform float s;
      uniform vec2 mouse;
      uniform float pulse;
      uniform float lamp;

      #define PI 3.14159265359

      float hash21(vec2 p){
        p=fract(p*vec2(123.34,456.21));
        p+=dot(p,p+45.32);
        return fract(p.x*p.y);
      }
      vec2 hash22(vec2 p){
        float n=hash21(p);
        return fract(vec2(n,n*1.2154)*vec2(437.11,289.73));
      }
      float noise(vec2 p){
        vec2 i=floor(p),f=fract(p);
        f=f*f*(3.0-2.0*f);
        float a=hash21(i),b=hash21(i+vec2(1,0)),c=hash21(i+vec2(0,1)),d=hash21(i+vec2(1,1));
        return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
      }
      float fbm(vec2 p){
        float v=0.0,a=.5;
        mat2 q=mat2(1.6,1.2,-1.2,1.6);
        // Three octaves retain broad movement while cutting fragment noise work by 40%.
        for(int i=0;i<3;i++){v+=a*noise(p);p=q*p;a*=.5;}
        return v;
      }
      float line(float d,float w){return (1.0-smoothstep(0.0,w,abs(d)));}
      float ring(float d,float rad,float w){return line(d-rad,w);}
      vec3 pal(float x,vec3 a,vec3 b,vec3 c){return a+b*cos(6.28318*(c*x+vec3(0.0,.17,.33)));}

      float voronoiEdge(vec2 x){
        vec2 n=floor(x),f=fract(x);
        float md=8.0,md2=8.0;
        for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){
          vec2 g=vec2(float(i),float(j));
          vec2 o=hash22(n+g);
          vec2 q=g+o-f;
          float d=dot(q,q);
          if(d<md){md2=md;md=d;}else if(d<md2){md2=d;}
        }
        return sqrt(md2)-sqrt(md);
      }

      vec4 fxWet(vec2 uv,vec2 p){
        vec2 g=uv*vec2(9.0,6.0); vec2 cell=floor(g); vec2 f=fract(g)-.5;
        vec2 o=hash22(cell)-.5; float rr=.08+.18*hash21(cell+7.1);
        float d=length(f-o*.65); float drop=(1.0-smoothstep(rr-.025,rr,d));
        float rim=ring(d,rr,.018); float streak=(1.0-smoothstep(0.0,.035,abs(f.x-o.x*.5))) * (1.0-smoothstep(-.15,.5,f.y)) * step(.66,hash21(cell+2.));
        float sheen=.5+.5*sin((uv.x+uv.y)*22.0+t*.35);
        vec3 c=vec3(.08,.24,.34)*drop+vec3(.55,.82,1.0)*rim*(.35+.65*sheen)+vec3(.15,.35,.5)*streak*.35;
        return vec4(c,(drop*.18+rim*.7+streak*.12)*s);
      }

      vec4 fxCold(vec2 uv,vec2 p){
        float e=voronoiEdge(p*7.0+fbm(p*2.0+t*.02));
        float crystal=(1.0-smoothstep(.015,.12,e));
        float edge=pow(max(max(uv.x,1.0-uv.x),max(uv.y,1.0-uv.y)),10.0);
        float sparkle=pow(hash21(floor(uv*r*0.13)+floor(t*1.5)),22.0);
        vec3 c=mix(vec3(.05,.18,.28),vec3(.72,.92,1.0),crystal)*(.35+.65*crystal)+sparkle*vec3(1.0);
        return vec4(c,clamp((crystal*.16+edge*.28+sparkle*.55)*s,0.0,.66));
      }

      vec4 fxFire(vec2 uv,vec2 p){
        float y=1.0-uv.y;
        float n=fbm(vec2(p.x*2.4,p.y*2.0-t*1.05));
        float flame=(1.0-smoothstep(.18,.76,y+n*.5+sin(p.x*9.0+t*1.7)*.04));
        flame*=(1.0-smoothstep(0.0,.72,y));
        float core=pow(flame,2.2);
        vec3 c=mix(vec3(.62,.05,.01),vec3(1.0,.9,.24),core);
        float spark=pow(hash21(floor(vec2(uv.x*80.0,(uv.y+t*.18)*70.0))),28.0)*(1.0-smoothstep(.2,.75,uv.y));
        c+=spark*vec3(1.0,.55,.12)*2.0;
        return vec4(c,clamp((flame*.34+spark*.8)*s,0.0,.74));
      }

      vec4 fxHot(vec2 uv,vec2 p){
        float haze=sin(p.y*34.0+t*2.2+fbm(p*5.0)*7.0)*.5+.5;
        float bands=pow(haze,5.0)*(1.0-uv.y);
        float n=fbm(vec2(p.x*4.0,p.y*2.0-t*.7));
        vec3 c=mix(vec3(.12,.01,0.0),vec3(1.0,.28,.02),bands*.8+n*.16);
        return vec4(c,(.04+n*.07+bands*.18)*s);
      }

      vec4 fxAcid(vec2 uv,vec2 p){
        float b=0.0;
        vec2 q=uv*vec2(10.0,7.0);
        vec2 id=floor(q),f=fract(q)-.5,o=hash22(id)-.5;
        float d=length(f-o*.75); float rr=.05+.22*hash21(id+3.0);
        b=ring(d,rr,.028)+(1.0-smoothstep(0.0,rr*.6,d))*.28;
        float rot=fbm(p*4.0+t*.15);
        float corrode=(1.0-smoothstep(.46,.72,rot));
        vec3 c=vec3(.37,.95,.10)*b+vec3(.10,.42,.03)*corrode*.28+vec3(.95,1.0,.25)*pow(b,4.0);
        return vec4(c,clamp((b*.42+corrode*.08)*s,0.0,.68));
      }

      vec4 fxPoison(vec2 uv,vec2 p){
        float n=fbm(vec2(p.x*2.2+t*.06,p.y*2.4-t*.08));
        float n2=fbm(vec2(p.x*5.0-t*.03,p.y*3.0+t*.04));
        float fog=smoothstep(.35,.82,n*.72+n2*.38);
        vec3 c=mix(vec3(.18,.24,.03),vec3(.78,.86,.16),n2)*fog;
        return vec4(c,(.04+fog*.23)*s);
      }

      vec4 fxRadiant(vec2 uv,vec2 p){
        vec2 q=p-vec2((mouse.x-.5)*.45,(mouse.y-.5)*-.35);
        float a=atan(q.y,q.x); float d=length(q);
        float rays=pow(max(0.0,sin(a*11.0+t*.23+fbm(q*2.0)*2.0)),10.0)/(1.0+d*3.0);
        float halo=ring(d,.22+.025*sin(t*.7),.03)+ring(d,.42,.045)*.35;
        float star=pow(hash21(floor(uv*r*.055)+floor(t*.6)),30.0);
        vec3 c=vec3(1.0,.87,.46)*(rays*.85+halo*.75)+vec3(1.0)*star;
        return vec4(c,clamp((rays*.34+halo*.3+star*.8)*s,0.0,.75));
      }

      vec4 fxNecrotic(vec2 uv,vec2 p){
        float n=fbm(p*3.0+vec2(t*.04,-t*.06));
        float veins=pow(1.0-abs(sin((p.x+n*.7)*11.0)+cos((p.y-n*.5)*9.0))*.5,7.0);
        float v=smoothstep(.25,.85,length(p));
        vec3 c=vec3(.11,.015,.16)*(.5+n)+vec3(.42,.06,.52)*veins*.55;
        return vec4(c,clamp((.08+n*.08+veins*.24+v*.12)*s,0.0,.62));
      }

      vec4 fxLightning(vec2 uv,vec2 p){
        float phase=floor(t*2.8); float flash=pow(hash21(vec2(phase,7.0)),9.0);
        float y=p.y; float boltX=(noise(vec2(y*3.5,phase))*2.0-1.0)*.24 + sin(y*11.0+phase)*.035;
        float bolt=line(p.x-boltX,.012+.012*flash);
        float branch=line(p.x-boltX-.16*sin(y*8.0+phase),.007)*step(.42,hash21(vec2(floor(y*8.0),phase)))*.65;
        float clickRing=ring(length(p-vec2((mouse.x-.5)*r.x/r.y,(.5-mouse.y))),pulse*.8,.035)*(1.0-pulse);
        vec3 c=vec3(.58,.76,1.0)*(bolt+branch)*2.2+vec3(.75,.86,1.0)*clickRing;
        return vec4(c,clamp((bolt*.9+branch*.55+flash*.12+clickRing*.6)*s,0.0,.85));
      }

      vec4 fxThunder(vec2 uv,vec2 p){
        vec2 c=vec2((mouse.x-.5)*r.x/r.y,(.5-mouse.y));
        float d=length(p-c); float f=fract(t*.35+pulse*.25);
        float rings=ring(d,f*1.15,.025)+ring(d,fract(f+.33)*1.15,.018)*.65+ring(d,fract(f+.66)*1.15,.014)*.38;
        vec3 col=vec3(.48,.62,.88)*rings;
        return vec4(col,clamp(rings*.45*s,0.0,.55));
      }

      vec4 fxForce(vec2 uv,vec2 p){
        vec2 q=p*5.0; q.x+=q.y*.57735; vec2 h=abs(fract(q)-.5); float grid=(1.0-smoothstep(0.0,.08,min(h.x,h.y)));
        float d=length(p); float wave=ring(d,fract(t*.22)*1.25,.024);
        float bend=sin((p.x*p.x+p.y*p.y)*30.0-t*2.0)*.5+.5;
        vec3 c=vec3(.26,.58,1.0)*(grid*.22+wave*.75)+vec3(.65,.82,1.0)*bend*.06;
        return vec4(c,clamp((grid*.09+wave*.34+bend*.045)*s,0.0,.54));
      }

      vec4 fxPsychic(vec2 uv,vec2 p){
        float n=fbm(p*3.0+sin(t*.3));
        float wave=sin(p.x*16.0+t*1.1+n*4.0)*sin(p.y*13.0-t*.8-n*3.0);
        float fracture=pow(abs(wave),5.0);
        vec3 c=pal(n+t*.03,vec3(.28,.05,.35),vec3(.22,.18,.28),vec3(1.0,.83,.62))*fracture;
        float scan=line(fract(uv.y*14.0+t*.08)-.5,.08)*.08;
        c+=vec3(.2,.75,.9)*scan;
        return vec4(c,clamp((fracture*.18+scan)*s,0.0,.48));
      }

      vec4 fxDarkness(vec2 uv,vec2 p){
        float n=fbm(p*2.2+vec2(t*.025,-t*.018));
        float vign=smoothstep(.12,.82,length(p)*(.78+n*.28));
        float tend=smoothstep(.58,.82,n);
        vec2 lampPos=vec2(mouse.x,1.0-mouse.y);
        float lampDist=length((uv-lampPos)*vec2(r.x/r.y,1.0));
        float pool=lamp*(1.0-smoothstep(.12,.34,lampDist));
        float edge=lamp*(1.0-smoothstep(.24,.39,lampDist))*smoothstep(.13,.25,lampDist);
        vec3 dark=vec3(.003,.002,.009);
        vec3 warm=vec3(.72,.34,.075);
        vec3 c=mix(dark,warm,edge*.24);
        float alpha=mix(.86,.025,pool);
        alpha=max(alpha,vign*.1+tend*.12);
        return vec4(c,clamp(alpha,0.0,.9));
      }

      vec4 fxWeb(vec2 uv,vec2 p){
        float a=atan(p.y,p.x),d=length(p);
        float radial=pow(max(0.0,cos(a*9.0)),24.0)*(1.0-smoothstep(.05,.9,d));
        float circles=pow(max(0.0,cos(d*55.0+sin(a*4.0)*1.5)),28.0)*(1.0-smoothstep(.05,.95,d));
        float stray=line(sin(p.x*7.0+p.y*5.0+t*.04)*.5,.035)*.22;
        float w=max(radial,circles)+stray;
        vec3 c=vec3(.72,.77,.82)*w;
        return vec4(c,clamp(w*.35*s,0.0,.52));
      }

      vec4 fxGrease(vec2 uv,vec2 p){
        float n=fbm(p*4.0+vec2(t*.025,0.0));
        float film=sin((p.x+p.y)*18.0+n*8.0+t*.18)*.5+.5;
        vec3 c=pal(film,vec3(.20,.12,.16),vec3(.18,.15,.20),vec3(1.0,.72,.45));
        float shine=pow(max(0.0,sin((p.x-n*.2)*25.0)),12.0);
        return vec4(c+shine*.25,clamp((.06+film*.08+shine*.14)*s,0.0,.4));
      }

      vec4 fxFaerie(vec2 uv,vec2 p){
        float n=hash21(floor(uv*r*.08));
        float twinkle=pow(max(0.0,sin(t*(.8+n*1.5)+n*30.0)),18.0)*step(.94,n);
        float wave=pow(max(0.0,sin((p.x+p.y)*8.0+t*.45)),12.0)*.12;
        vec3 c=pal(n+t*.02,vec3(.34,.20,.55),vec3(.26,.32,.32),vec3(1.0,.72,.44))*(twinkle+wave);
        return vec4(c,clamp((twinkle*.72+wave*.4)*s,0.0,.6));
      }

      vec4 fxPetrified(vec2 uv,vec2 p){
        float e=voronoiEdge(p*5.0); float crack=(1.0-smoothstep(0.0,.055,e));
        float grain=noise(p*45.0)*.5+noise(p*12.0)*.5;
        vec3 c=mix(vec3(.12,.13,.14),vec3(.42,.40,.36),grain)*(.25+crack*.75);
        return vec4(c,clamp((.055+crack*.28)*s,0.0,.45));
      }

      void main(){
        vec2 uv=gl_FragCoord.xy/r;
        vec2 p=(uv-.5)*vec2(r.x/r.y,1.0);
        vec4 outc=vec4(0.0);
        if(m<.5) outc=vec4(0.0);
        else if(m<1.5) outc=fxWet(uv,p);
        else if(m<2.5) outc=fxCold(uv,p);
        else if(m<3.5) outc=fxFire(uv,p);
        else if(m<4.5) outc=fxHot(uv,p);
        else if(m<5.5) outc=fxAcid(uv,p);
        else if(m<6.5) outc=fxPoison(uv,p);
        else if(m<7.5) outc=fxRadiant(uv,p);
        else if(m<8.5) outc=fxNecrotic(uv,p);
        else if(m<9.5) outc=fxLightning(uv,p);
        else if(m<10.5) outc=fxThunder(uv,p);
        else if(m<11.5) outc=fxForce(uv,p);
        else if(m<12.5) outc=fxPsychic(uv,p);
        else if(m<13.5) outc=fxDarkness(uv,p);
        else if(m<14.5) outc=fxWeb(uv,p);
        else if(m<15.5) outc=fxGrease(uv,p);
        else if(m<16.5) outc=fxFaerie(uv,p);
        else outc=fxPetrified(uv,p);
        gl_FragColor=outc;
      }
    `;

    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    u = {
      r: gl.getUniformLocation(program,'r'), t: gl.getUniformLocation(program,'t'),
      m: gl.getUniformLocation(program,'m'), s: gl.getUniformLocation(program,'s'),
      mouse: gl.getUniformLocation(program,'mouse'), pulse: gl.getUniformLocation(program,'pulse'),
      lamp: gl.getUniformLocation(program,'lamp')
    };

    let lastFrame = 0;
    const loop = ts => {
      if (!modeName || modeName === 'none' || document.hidden) { raf = 0; return; }
      raf = requestAnimationFrame(loop);
      if (ts - lastFrame < 1000 / 30) return;
      lastFrame = ts;
      const reduced = reduceMotion();
      if (reduced && modeName !== 'darkness' && ts % 500 > 20) return;
      const hc = navigator.hardwareConcurrency || 4;
      const cap = innerWidth <= 820 ? .58 : hc <= 4 ? .62 : hc <= 8 ? .72 : .82;
      const dpr = Math.min(devicePixelRatio || 1, cap);
      const w = Math.max(2, Math.round(innerWidth * dpr));
      const h = Math.max(2, Math.round(innerHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h; gl.viewport(0,0,w,h);
      }
      pointerPulse = Math.max(0, pointerPulse - .018);
      gl.uniform2f(u.r,w,h);
      gl.uniform1f(u.t, reduced ? 0 : ts*.001);
      gl.uniform1f(u.m, MODES[modeName] || 0);
      gl.uniform1f(u.s, intensity);
      renderPointerX += (pointerX - renderPointerX) * .34;
      renderPointerY += (pointerY - renderPointerY) * .34;
      gl.uniform2f(u.mouse,renderPointerX,renderPointerY);
      gl.uniform1f(u.pulse,pointerPulse);
      const finePointer = matchMedia('(pointer: fine)').matches && innerWidth > 820;
      gl.uniform1f(u.lamp,active.includes('lantern') && finePointer ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES,0,3);
    };
    renderLoop = loop;
    raf = requestAnimationFrame(loop);
  }

  function apply({ effects = [], intensity: nextIntensity = .35 } = {}) {
    active = [...new Set((effects || []).map(String))];
    intensity = clamp(Number(nextIntensity) || 0, 0, 1);
    pointerCssActive = active.some(name => ['hot','grease','force','thunder'].includes(name));
    applySurfaceChannels(active, intensity);
    modeName = chooseShader(active) || 'none';
    if (!canvas && modeName !== 'none') createRenderer();
    if (canvas) {
      canvas.dataset.mode = modeName;
      const touchDarkness = modeName === 'darkness' && (!matchMedia('(pointer: fine)').matches || innerWidth <= 820);
      canvas.style.opacity = modeName === 'none' ? '0' : modeName === 'darkness' ? (touchDarkness ? '.34' : String(.82 + intensity * .16)) : String(.24 + intensity * .5);
      canvas.style.mixBlendMode = ['darkness','necrotic','psychic'].includes(modeName) ? 'normal' : 'screen';
      canvas.style.zIndex = modeName === 'darkness' ? '40' : '';
    }
    if (modeName === 'none' || document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf && renderLoop) {
      raf = requestAnimationFrame(renderLoop);
    }
    root.dataset.ltShader = modeName;
    root.dataset.ltGameplayEffects = active.filter(x => MODES[x]).join(' ');
  }

  function clear() { apply({ effects: [], intensity: 0 }); }

  addEventListener('pointermove', e => {
    pointerX = clamp(e.clientX / Math.max(1, innerWidth), 0, 1);
    pointerY = clamp(e.clientY / Math.max(1, innerHeight), 0, 1);
    if (pointerCssActive && !pointerCssRaf) {
      pointerCssRaf = requestAnimationFrame(() => {
        pointerCssRaf = 0;
        root.style.setProperty('--lt-fx-x', `${(pointerX*100).toFixed(1)}%`);
        root.style.setProperty('--lt-fx-y', `${(pointerY*100).toFixed(1)}%`);
      });
    }
  }, { passive: true });
  addEventListener('pointerdown', () => { pointerPulse = 1; }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (canvas) canvas.style.visibility = document.hidden ? 'hidden' : 'visible';
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else if (modeName !== 'none' && renderLoop && !raf) {
      raf = requestAnimationFrame(renderLoop);
    }
  });

  window.LanternDndFx = Object.freeze({
    apply, clear,
    effects: Object.freeze(Object.keys(MODES)),
    modes: MODES,
    legacyShaderEffects: LEGACY_SHADER_EFFECTS,
  });
})();
