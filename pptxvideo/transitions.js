/**
 * transitions.js — MLApplications
 * GPU transitions between two complete frames (WebGL), in the spirit of FFmpeg's xfade filter,
 * plus matte transitions: a grayscale mask video decides where the next slide shows through
 * (black = slide A, white = slide B) – the same idea as Desktop Live Wallpaper+.
 *
 *   const gl = new TransitionGL();
 *   gl.render(ctx2d, canvasA, canvasB, { kind: 'gl', name: 'circleopen' }, progress);
 *   gl.render(ctx2d, canvasA, canvasB, { kind: 'matte', glow: 0.6 }, progress, matteCanvas);
 */

// Each body returns the output colour for uv (0,0 = top-left). Helpers: A(uv), B(uv), p, res, aspect, soft, rand(), wipe().
export const GL_TRANSITIONS = [
  { id: 'fade',        label: 'Fade',            group: 'Basic',  body: 'return mix(A(uv), B(uv), p);' },
  { id: 'fadeblack',   label: 'Fade to black',   group: 'Basic',  body: 'return p < .5 ? mix(A(uv), vec4(0.,0.,0.,1.), p*2.) : mix(vec4(0.,0.,0.,1.), B(uv), p*2.-1.);' },
  { id: 'fadewhite',   label: 'Fade to white',   group: 'Basic',  body: 'return p < .5 ? mix(A(uv), vec4(1.), p*2.) : mix(vec4(1.), B(uv), p*2.-1.);' },
  { id: 'dissolve',    label: 'Dissolve',        group: 'Basic',  body: 'float r = rand(floor(uv*res/3.)); return mix(A(uv), B(uv), smoothstep(r-.08, r+.08, p*1.16-.08));' },
  { id: 'hblur',       label: 'Blur cross',      group: 'Basic',  body: 'float k = sin(p*3.14159)*.035; vec4 s = vec4(0.); for (int i = -6; i <= 6; i++) { vec2 o = vec2(float(i)*k/6., 0.); s += mix(A(uv+o), B(uv+o), p); } return s/13.;' },
  { id: 'pixelize',    label: 'Pixelize',        group: 'Basic',  body: 'float q = min(p, 1.-p)*2.; float cell = max(1., q*res.y/14.); vec2 c = (floor(uv*res/cell)+.5)*cell/res; return mix(A(c), B(c), smoothstep(.42, .58, p));' },
  { id: 'zoomin',      label: 'Zoom in',         group: 'Basic',  body: 'vec2 c = uv-.5; return mix(A(.5+c/(1.+p*1.4)), B(uv), smoothstep(.15, 1., p));' },
  { id: 'zoomout',     label: 'Zoom out',        group: 'Basic',  body: 'vec2 c = uv-.5; return mix(A(uv), B(.5+c*(1.+(1.-p)*1.4)), smoothstep(0., .85, p));' },

  { id: 'wipeleft',    label: 'Wipe left',       group: 'Wipe & slide', body: 'return mix(A(uv), B(uv), wipe(1.-uv.x));' },
  { id: 'wiperight',   label: 'Wipe right',      group: 'Wipe & slide', body: 'return mix(A(uv), B(uv), wipe(uv.x));' },
  { id: 'wipeup',      label: 'Wipe up',         group: 'Wipe & slide', body: 'return mix(A(uv), B(uv), wipe(1.-uv.y));' },
  { id: 'wipedown',    label: 'Wipe down',       group: 'Wipe & slide', body: 'return mix(A(uv), B(uv), wipe(uv.y));' },
  { id: 'diagonal',    label: 'Diagonal wipe',   group: 'Wipe & slide', body: 'return mix(A(uv), B(uv), wipe((uv.x+uv.y)*.5));' },
  { id: 'slideleft',   label: 'Push left',       group: 'Wipe & slide', body: 'float x = uv.x+p; return x < 1. ? A(vec2(x, uv.y)) : B(vec2(x-1., uv.y));' },
  { id: 'slideright',  label: 'Push right',      group: 'Wipe & slide', body: 'float x = uv.x-p; return x >= 0. ? A(vec2(x, uv.y)) : B(vec2(x+1., uv.y));' },
  { id: 'slideup',     label: 'Push up',         group: 'Wipe & slide', body: 'float y = uv.y+p; return y < 1. ? A(vec2(uv.x, y)) : B(vec2(uv.x, y-1.));' },
  { id: 'slidedown',   label: 'Push down',       group: 'Wipe & slide', body: 'float y = uv.y-p; return y >= 0. ? A(vec2(uv.x, y)) : B(vec2(uv.x, y+1.));' },
  { id: 'coverleft',   label: 'Cover',           group: 'Wipe & slide', body: 'float x = uv.x-(1.-p); return x >= 0. ? B(vec2(x, uv.y)) : A(uv);' },
  { id: 'uncoverleft', label: 'Uncover',         group: 'Wipe & slide', body: 'float x = uv.x+p; return x < 1. ? A(vec2(x, uv.y)) : B(uv);' },

  { id: 'circleopen',  label: 'Circle open',     group: 'Shapes', body: 'vec2 d = (uv-.5)*vec2(aspect, 1.); float R = length(vec2(aspect*.5, .5)); float t = p*(R+soft); return mix(A(uv), B(uv), 1.-smoothstep(t-soft, t, length(d)));' },
  { id: 'circleclose', label: 'Circle close',    group: 'Shapes', body: 'vec2 d = (uv-.5)*vec2(aspect, 1.); float R = length(vec2(aspect*.5, .5)); float t = (1.-p)*(R+soft); return mix(A(uv), B(uv), smoothstep(t-soft, t, length(d)));' },
  { id: 'radial',      label: 'Clock',           group: 'Shapes', body: 'vec2 d = (uv-.5)*vec2(aspect, 1.); float a = atan(d.x, -d.y)/6.2831853+.5; return mix(A(uv), B(uv), 1.-smoothstep(p*1.04-.02, p*1.04, a));' },
  { id: 'diamond',     label: 'Diamond',         group: 'Shapes', body: 'vec2 d = abs(uv-.5)*vec2(aspect, 1.); float t = p*(aspect*.5+.5+soft); return mix(A(uv), B(uv), 1.-smoothstep(t-soft, t, d.x+d.y));' },
  { id: 'blinds',      label: 'Blinds',          group: 'Shapes', body: 'float f = fract(uv.x*10.); return mix(A(uv), B(uv), 1.-smoothstep(p-.04, p+.04, f));' },
  { id: 'squares',     label: 'Squares',         group: 'Shapes', body: 'vec2 g = floor(uv*vec2(16., 9.)); float r = rand(g)*.6; return mix(A(uv), B(uv), smoothstep(r, r+.4, p));' },
];

const VERT = `attribute vec2 pos; varying vec2 uv;
void main() { uv = vec2(pos.x*.5+.5, .5-pos.y*.5); gl_Position = vec4(pos, 0., 1.); }`;

const HEAD = `precision highp float;
varying vec2 uv;
uniform sampler2D tA, tB, tM;
uniform float p, soft, glow, aspect;
uniform vec2 res;
uniform vec3 glowColor;
vec4 A(vec2 u) { return texture2D(tA, clamp(u, 0., 1.)); }
vec4 B(vec2 u) { return texture2D(tB, clamp(u, 0., 1.)); }
float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
float wipe(float x) { float t = p*(1.+2.*soft)-soft; return 1.-smoothstep(t-soft, t+soft, x); }
`;

const MATTE_BODY = `float m = texture2D(tM, uv).r;
  m = smoothstep(.5-soft, .5+soft, m);
  vec4 c = mix(A(uv), B(uv), m);
  float e = 1.-abs(m*2.-1.);
  c.rgb += glowColor*glow*e*e;
  return c;`;

export class TransitionGL {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false })
      || this.canvas.getContext('experimental-webgl');
    this.gl = gl || null;
    this.programs = new Map();
    if (!gl) return;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.tex = [0, 1, 2].map(() => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    });
  }
  get ok() { return !!this.gl; }

  _program(key, body) {
    if (this.programs.has(key)) return this.programs.get(key);
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Transition shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, HEAD + `vec4 tr(vec2 uv) { ${body} }\nvoid main() { gl_FragColor = tr(uv); }`));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Transition program: ' + gl.getProgramInfoLog(prog));
    const u = (n) => gl.getUniformLocation(prog, n);
    const entry = { prog, pos: gl.getAttribLocation(prog, 'pos'),
      tA: u('tA'), tB: u('tB'), tM: u('tM'), p: u('p'), soft: u('soft'), glow: u('glow'), aspect: u('aspect'), res: u('res'), glowColor: u('glowColor') };
    this.programs.set(key, entry);
    return entry;
  }

  _upload(unit, src) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[unit]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  /**
   * Draw the transition frame into ctx (same size as A/B).
   * def: { kind: 'gl', name } | { kind: 'matte', soft?, glow?, glowColor? };  matte: canvas/image/video for 'matte'
   * Returns false when WebGL is unavailable (caller should fall back).
   */
  render(ctx, A, B, def, p, matte = null) {
    if (!this.gl) return false;
    const gl = this.gl;
    const W = A.width, H = A.height;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    let pr;
    if (def.kind === 'matte') {
      if (!matte) return false;
      pr = this._program('matte', MATTE_BODY);
    } else {
      const t = GL_TRANSITIONS.find(x => x.id === def.name) || GL_TRANSITIONS[0];
      pr = this._program(t.id, t.body);
    }
    gl.viewport(0, 0, W, H);
    gl.useProgram(pr.prog);
    gl.enableVertexAttribArray(pr.pos);
    gl.vertexAttribPointer(pr.pos, 2, gl.FLOAT, false, 0, 0);
    this._upload(0, A); gl.uniform1i(pr.tA, 0);
    this._upload(1, B); gl.uniform1i(pr.tB, 1);
    if (def.kind === 'matte') { this._upload(2, matte); gl.uniform1i(pr.tM, 2); }
    gl.uniform1f(pr.p, Math.max(0, Math.min(1, p)));
    gl.uniform1f(pr.soft, def.kind === 'matte' ? (def.soft ?? 0.06) : (def.soft ?? 0.02));
    gl.uniform1f(pr.glow, def.glow ?? 0);
    gl.uniform1f(pr.aspect, W / H);
    gl.uniform2f(pr.res, W, H);
    const gc = def.glowColor || [1, 0.85, 0.55];
    gl.uniform3f(pr.glowColor, gc[0], gc[1], gc[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    ctx.drawImage(this.canvas, 0, 0, W, H);
    return true;
  }
}

/** Two little sample frames (A: blue, B: orange) for picker thumbnails. */
export function sampleFrames(w = 192, h = 108) {
  const mk = (c1, c2, letter) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, c1); g.addColorStop(1, c2);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(255,255,255,.9)';
    x.font = `bold ${Math.round(h * 0.42)}px system-ui, sans-serif`;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(letter, w / 2, h / 2 + 2);
    return c;
  };
  return { A: mk('#1e3a8a', '#3b82f6', 'A'), B: mk('#c2410c', '#fbbf24', 'B') };
}
