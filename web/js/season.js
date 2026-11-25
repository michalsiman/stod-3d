// Roční období: den v roce (1–365) jako sdílená uniforma; barvy luk, polí a listnatých stromů
// se podle něj mění (jaro zelené, léto zralé obilí a strniště, podzim zorané a hnědé, listí žloutne
// a opadá, v zimě šedohnědá tráva a holé stromy). Nastavuje sun.js (createTimeControls).

export const SEASON = { doy: { value: 172 }, snow: { value: 0 } };

export const SEASON_GLSL = /* glsl */ `
uniform float uDoy;
uniform float uSnow;          // 0 bez sněhu … 1 zasněženo
// sněhová pokrývka: plochy shora bílé, mírně modravé ve stínu, tráva místy prosvítá
vec3 snowy(vec3 c, float k){ float l = dot(c, vec3(.3, .55, .15)); return mix(c, vec3(.93, .95, .99) * (.86 + l * .5), uSnow * k); }
// listí na listnáčích: raší v dubnu, opadává koncem října a v listopadu
float leafAmt(){ return smoothstep(100., 128., uDoy) * (1. - smoothstep(292., 320., uDoy)); }
float autumnAmt(){ return smoothstep(262., 295., uDoy); }
// svěžest trávy: zima tlumená, jaro sytě zelená, v létě mírně vyprahlá, na podzim šedne
float grassLush(){
  float spring = smoothstep(70., 120., uDoy);
  float dry = smoothstep(185., 225., uDoy) * (1. - smoothstep(250., 275., uDoy)) * .3;
  float fall = smoothstep(272., 322., uDoy);
  return clamp(spring - dry - fall * .78, .14, 1.);
}
vec3 dullGrass(vec3 c){ return vec3(dot(c, vec3(.36, .5, .14))) * vec3(1.1, 1., .74); }
vec3 seasonGrass(vec3 c){ return mix(dullGrass(c), c, grassLush()); }
// pole podle plodiny (st: 0 ozim, 1 jařina, 2 kukuřice / řepka); G zelené, Y zralé, B zorané
vec3 seasonField(int st, vec3 G, vec3 Y, vec3 B){
  vec3 S = hexc(206, 188, 142), D = hexc(116, 132, 86);
  float d = uDoy; vec3 c;
  if (st == 0) {
    c = D;
    c = mix(c, G, smoothstep(80., 115., d)); c = mix(c, Y, smoothstep(172., 198., d));
    c = mix(c, S, smoothstep(205., 220., d)); c = mix(c, B, smoothstep(232., 252., d));
    c = mix(c, D, smoothstep(288., 315., d));
  } else if (st == 1) {
    c = B;
    c = mix(c, mix(B, G, .55), smoothstep(95., 120., d)); c = mix(c, G, smoothstep(120., 142., d));
    c = mix(c, Y, smoothstep(212., 236., d)); c = mix(c, S, smoothstep(242., 256., d));
    c = mix(c, B, smoothstep(262., 285., d));
  } else {
    c = B;
    c = mix(c, G, smoothstep(130., 162., d)); c = mix(c, mix(G, Y, .5), smoothstep(232., 258., d));
    c = mix(c, B, smoothstep(272., 294., d));
  }
  return c;
}
// koruna listnáče: podzimní barvy, pak holé šedohnědé větve
vec3 seasonLeaf(vec3 c){
  float l = dot(c, vec3(.3, .55, .15));
  vec3 aut = mix(hexc(214, 150, 52), hexc(178, 86, 40), fract(l * 37.)) * (.6 + l * 2.2);
  c = mix(c, aut, autumnAmt() * .85);
  vec3 bare = hexc(112, 100, 88) * (.75 + l * 1.6);
  return mix(bare, c, leafAmt());
}
`;
