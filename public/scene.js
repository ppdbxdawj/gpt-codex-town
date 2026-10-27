import * as THREE from 'three';
import { OrbitControls } from '/vendor/OrbitControls.js';
import { normalizeVillageAutomations, planVillageLots } from './schedule-village.js';
import { compactAutomationState, compactInboxState, compactTaskState } from './compact-state.js';

// The manor is a view of task state. It never starts or changes an agent task.
export function createManorScene({ container, onSelect = () => {} }) {
  const scene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .94;
  renderer.domElement.setAttribute('aria-label', '星糖庄园 3D 场景，可拖动旋转，滚轮缩放。建筑也可通过标签按钮选择。');
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
  container.append(renderer.domElement);
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  const camera = new THREE.OrthographicCamera(-14, 14, 11, -11, .1, 100);
  const home = new THREE.Vector3(17, 19, 24);
  const compactHome = new THREE.Vector3(17, 13.5, 25);
  camera.position.copy(home);
  camera.zoom = 1.12;
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.dampingFactor = .09;
  controls.minZoom = .7;
  controls.maxZoom = 3.2;
  controls.minPolarAngle = .25;
  controls.maxPolarAngle = Math.PI / 2.6;
  controls.enablePan = false;
  controls.update();
  const hemi = new THREE.HemisphereLight(0xfff7ee, 0xc9b1ce, 3.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffeddc, 4);
  sun.position.set(-8, 18, 11);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 14, bottom: -14, near: 1, far: 60 });
  sun.shadow.bias = -.0005;
  sun.shadow.normalBias = .04;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xceaaff, 1.1);
  rim.position.set(10, 5, -6); scene.add(rim);

  const mats = new Map(), geos = new Map();
  const material = (color, options = {}) => {
    const key = color + JSON.stringify(options);
    if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: .72, ...options }));
    return mats.get(key);
  };
  const palette = {
    cream: material('#fff2dd'), pink: material('#efaebd'), blush: material('#f4cfce'), purple: material('#b9a2d6'),
    mint: material('#98cdb7'), grass: material('#bfdbb4'), gold: material('#e8bc7c'), dark: material('#695b71'),
    brown: material('#a77b72'), white: material('#fffdf4'), water: material('#8fd7db', { roughness: .18, metalness: .15 }),
    glass: material('#b9ede0', { transparent: true, opacity: .43, roughness: .15, metalness: .12, depthWrite: false }),
    window: material('#ffc980', { emissive: '#ffa64f', emissiveIntensity: .16, roughness: .35 }),
    rail: material('#b9caff', { emissive: '#7876ff', emissiveIntensity: .13, metalness: .3, roughness: .35 }),
  };
  function boxGeo(w,h,d,r=.12) {
    const key = ['box',w,h,d,r].join(); if (geos.has(key)) return geos.get(key);
    r = Math.min(r,w/3,h/3,d/3);
    const x=-w/2+r, y=-h/2+r, W=w-2*r,H=h-2*r;
    const s=new THREE.Shape();
    s.moveTo(x+r,y); s.lineTo(x+W-r,y); s.quadraticCurveTo(x+W,y,x+W,y+r);
    s.lineTo(x+W,y+H-r); s.quadraticCurveTo(x+W,y+H,x+W-r,y+H);
    s.lineTo(x+r,y+H); s.quadraticCurveTo(x,y+H,x,y+H-r);
    s.lineTo(x,y+r); s.quadraticCurveTo(x,y,x+r,y);
    const g = new THREE.ExtrudeGeometry(s,{depth:d-2*r,bevelEnabled:true,bevelSize:r,bevelThickness:r,bevelSegments:2,steps:1,curveSegments:4});
    g.center(); geos.set(key,g); return g;
  }
  function sphereGeo(r=1) { const k='sphere'+r; if(!geos.has(k))geos.set(k,new THREE.SphereGeometry(r,16,10));return geos.get(k); }
  function cylGeo(top,bottom,h,n=12) {const k=['cyl',top,bottom,h,n].join();if(!geos.has(k))geos.set(k,new THREE.CylinderGeometry(top,bottom,h,n));return geos.get(k);}
  function mesh(geo,mat,parent,x=0,y=0,z=0,shadow=true){const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.castShadow=shadow;m.receiveShadow=true;parent.add(m);return m;}
  const box=(p,w,h,d,m,x=0,y=0,z=0,r=.12)=>mesh(boxGeo(w,h,d,r),m,p,x,y,z);
  const ball=(p,r,m,x=0,y=0,z=0,s=[1,1,1])=>{const o=mesh(sphereGeo(r),m,p,x,y,z);o.scale.set(...s);return o;};
  const cyl=(p,rt,rb,h,m,x=0,y=0,z=0,n=12)=>mesh(cylGeo(rt,rb,h,n),m,p,x,y,z);
  function tube(points,r,mat,parent,closed=false){const curve=new THREE.CatmullRomCurve3(points,closed);return mesh(new THREE.TubeGeometry(curve,Math.max(24,points.length*6),r,6,closed),mat,parent);}
  function star(p,r,mat,x,y,z){const s=new THREE.Shape();for(let i=0;i<10;i++){const a=i*Math.PI/5+Math.PI/2,R=i%2?r*.46:r;const X=Math.cos(a)*R,Y=Math.sin(a)*R;i?s.lineTo(X,Y):s.moveTo(X,Y);}s.closePath();const g=new THREE.ExtrudeGeometry(s,{depth:.09,bevelEnabled:true,bevelSize:.035,bevelThickness:.035,bevelSegments:1});return mesh(g,mat,p,x,y,z);}
  const land=new THREE.Group();scene.add(land);
  const manorPlinth=[
    box(land,23,1.1,17,palette.cream,0,-.65,0,1),
    box(land,22.6,.4,16.6,palette.blush,0,-.09,0,.65),
    box(land,22.3,.22,16.3,palette.grass,0,.2,0,.55),
  ];
  // An inset miniature landscape, framed like a collectible diorama.
  const floor=mesh(new THREE.PlaneGeometry(200,200),material('#eadde7'),scene,0,-1.25,0,false);floor.rotation.x=-Math.PI/2;
  // Mini mode trades the rectangular product plinth for a soft floating island.
  // The city itself stays in `land`, so every building, path, owner, and real-state
  // animation keeps its existing coordinates and interaction contract.
  const dreamIsland=new THREE.Group();dreamIsland.visible=false;scene.add(dreamIsland);
  const islandShape=new THREE.Shape();
  for(let i=0;i<18;i++){
    const a=i/18*Math.PI*2;
    const wobble=1+Math.sin(i*2.17)*.055+Math.cos(i*4.1)*.035;
    const x=Math.cos(a)*12.7*wobble,z=Math.sin(a)*9.55*wobble;
    i?islandShape.lineTo(x,z):islandShape.moveTo(x,z);
  }
  islandShape.closePath();
  const dreamGrass=mesh(new THREE.ShapeGeometry(islandShape),palette.grass,dreamIsland,0,.305,0,false);dreamGrass.rotation.x=-Math.PI/2;
  const dreamLayers=[];
  function dreamLayer(top,bottom,height,y,mat,rotation=0){
    const layer=mesh(new THREE.CylinderGeometry(top,bottom,height,18,1,false),mat,dreamIsland,0,y,0,false);
    layer.scale.z=.74;layer.rotation.y=rotation;dreamLayers.push(layer);return layer;
  }
  const dreamCream=material('#ffe0ba'),dreamPink=material('#efa5bd'),dreamLavender=material('#b494df'),dreamCore=material('#ab8ad2');
  dreamLayer(12.45,11.25,1.15,-.25,dreamCream,.12);
  dreamLayer(11.18,8.85,1.55,-1.6,dreamPink,-.07);
  dreamLayer(8.78,5.25,2,-3.375,dreamLavender,.18);
  dreamLayer(5.18,.82,2.8,-5.775,dreamCore,-.12);
  const dreamClouds=[],dreamStars=[];
  function dreamCloud(x,y,z,scale=1){
    const cloud=new THREE.Group();cloud.position.set(x,y,z);cloud.scale.setScalar(scale);dreamIsland.add(cloud);
    for(const [cx,cy,cz,r] of [[0,0,0,.48],[-.42,-.03,.08,.34],[.42,.04,.02,.38],[.08,.18,-.18,.28]])ball(cloud,r,palette.white,cx,cy,cz,[1.45,.9,1]);
    dreamClouds.push({cloud,baseY:y,phase:dreamClouds.length*.8});
  }
  function dreamlet(x,y,z,scale=1){
    const g=new THREE.Group();g.position.set(x,y,z);g.scale.setScalar(scale);dreamIsland.add(g);
    cyl(g,.95,.58,.34,palette.cream,0,0,0,12);cyl(g,.72,.94,.42,palette.purple,0,-.35,0,12);ball(g,.83,palette.grass,0,.22,0,[1.18,.22,.88]);
  }
  // Large, offset cloud banks give the low silhouette a soft floating cradle
  // without covering the city or the tapered island point.
  dreamCloud(-14.2,-1.45,2.7,2.15);dreamCloud(14,-1.2,3.8,1.95);
  dreamCloud(-11.2,-.78,6.2,1.18);dreamCloud(10.8,-.6,6.5,1.05);
  dreamlet(-10.8,-.3,4.8,.5);dreamlet(10.7,.15,-3.9,.43);
  for(let i=0;i<18;i++){
    const a=i*2.4;const sparkle=star(dreamIsland,.045+(i%3)*.025,palette.window,Math.cos(a)*(8.8+i%3*.4),.72+(i%4)*.55,Math.sin(a)*(6.8+i%4*.32));
    sparkle.rotation.x=Math.PI/2;dreamStars.push({sparkle,phase:i*.7});
  }
  cyl(land,2.7,2.7,.07,material('#f3dfcd'),0,.37,.6,64);
  cyl(land,2.23,2.23,.08,material('#f8ecdc'),0,.42,.6,64);
  for(let i=0;i<20;i++){const a=i/20*Math.PI*2;box(land,.35,.05,.24,palette.pink,Math.cos(a)*2.5,.43,.6+Math.sin(a)*2.5,.03);}
  // Winding paths connect all four real destinations.
  const pathmat=material('#f5e9d7');
  for(const [x,z,w,d] of [[-3.4,-.7,5.8,1.1],[1,-2.1,1.3,4.5],[3.5,.6,6.2,1.2],[1,3.1,1.3,4.9]])box(land,w,.08,d,pathmat,x,.37,z,.2);
  const fountain=new THREE.Group();fountain.position.set(0,.44,.6);land.add(fountain);
  cyl(fountain,1.04,1.14,.24,palette.cream,0,.12,0,32);
  cyl(fountain,.89,.89,.06,palette.water,0,.27,0,32);
  cyl(fountain,.14,.22,.65,palette.pink,0,.61,0);
  ball(fountain,.38,palette.gold,0,1.04,0);
  const centerStar=star(fountain,.42,palette.window,0,1.7,0);
  const ring=new THREE.Mesh(new THREE.TorusGeometry(.67,.025,6,48),palette.rail);ring.rotation.x=Math.PI/2;ring.position.y=1.36;fountain.add(ring);

  const buildings=[],pickables=[], labels=[], destination=new Map();
  // All rotating or travelling pieces are created once. The frame loop only transforms them.
  const motion={belts:[],gears:[],windmills:[],starTracks:[],clouds:[],droplets:[],signals:[],workLights:[],greenhouseRotor:null};
  function registerBuilding(g,b,height){
    g.userData={id:b.id,title:b.title,kind:b.kind,filter:b.filter||b.id};
    destination.set(b.id,g.position.clone());buildings.push(b);
    g.traverse(o=>{if(o.isMesh){o.userData.building=g.userData;pickables.push(o);}});
    makeLabel(b,height);
    return b;
  }
  function gear(parent,mat,x,y,z,r=.36){
    const g=new THREE.Group();g.position.set(x,y,z);parent.add(g);
    const wheel=new THREE.Mesh(new THREE.TorusGeometry(r,r*.16,6,16),mat);wheel.castShadow=true;wheel.receiveShadow=true;g.add(wheel);
    for(let i=0;i<8;i++){const tooth=box(g,r*.16,r*.22,r*.13,mat,Math.cos(i*Math.PI/4)*(r+r*.04),Math.sin(i*Math.PI/4)*(r+r*.04),0,.02);tooth.rotation.z=i*Math.PI/4;}
    motion.gears.push(g);return g;
  }
  function addWorkshop(){
    const g=new THREE.Group();g.position.set(-5.4,.42,-1.55);land.add(g);
    box(g,4.25,.26,3.35,palette.cream,0,.12,0,.22);
    // A deliberately stepped silhouette: tall rear engine, mid workshop and low loading deck.
    box(g,1.45,2.7,2.15,palette.purple,-.95,1.48,-.2,.16);
    box(g,1.55,2.02,2.35,palette.blush,.55,1.13,-.08,.16);
    box(g,1.1,1.14,2.45,palette.cream,1.48,.69,.02,.14);
    for(const [x,y,w] of [[-.95,2.42,1.22],[.55,1.82,1.31],[1.48,1.12,.88]])box(g,w,.13,2.5,palette.white,x,y,-.08,.05);
    // Conveyor and loading rollers make the workshop recognisable even in mini mode.
    const belt=new THREE.Group();belt.position.set(.82,.55,1.55);g.add(belt);
    box(belt,2.55,.1,.55,palette.dark,0,0,0,.04);
    for(const x of [-1.12,0,1.12]){const roller=cyl(belt,.12,.12,.67,palette.gold,x,.04,0);roller.rotation.x=Math.PI/2;}
    for(let i=0;i<3;i++){const parcel=box(belt,.3,.22,.3,i%2?palette.pink:palette.gold,-.85+i*.8,.18,0,.04);motion.belts.push({parcel,phase:i/3});}
    gear(g,palette.gold,-1.72,.96,1.21,.47);gear(g,palette.purple,-1.15,.76,1.28,.31);gear(g,palette.gold,.05,.93,1.28,.36);
    // Pipes terminate in a short chimney and make a clear machine profile, rather than a house roof.
    tube([new THREE.Vector3(-1.5,2.52,-.86),new THREE.Vector3(-1.5,3.22,-.86),new THREE.Vector3(-.12,3.22,-.86),new THREE.Vector3(-.12,2.64,-.86)],.105,palette.gold,g);
    cyl(g,.22,.25,1.02,palette.purple,-1.5,3.06,-.86);cyl(g,.31,.31,.1,palette.cream,-1.5,3.59,-.86);
    for(const x of [-.95,.56]){box(g,.62,.7,.05,palette.window,x,1.35,1.05,.1);box(g,.06,.78,.055,palette.cream,x,1.35,1.08,.01);}
    const statusOrb=ball(g,.15,palette.mint,0,3.82,0);const halo=new THREE.Mesh(new THREE.TorusGeometry(.31,.028,5,24),palette.rail);halo.rotation.x=Math.PI/2;halo.position.set(0,3.82,0);g.add(halo);
    for(let i=0;i<3;i++){const light=ball(g,.07,palette.window,-1.5+i*.72,2.72,1.21);motion.workLights.push({light,phase:i/3,baseY:2.72});}
    return registerBuilding(g,{id:'codex',title:'Codex 工坊',g,statusOrb,halo,status:'unknown',kind:'workshop'},4.02);
  }
  function addObservatory(){
    const g=new THREE.Group();g.position.set(.6,.42,-4.4);land.add(g);
    box(g,3.45,.24,3.35,palette.cream,0,.12,0,.24);
    cyl(g,1.38,1.52,1.42,palette.pink,0,.91,0,24);
    const dome=mesh(new THREE.SphereGeometry(1.45,24,14,0,Math.PI*2,0,Math.PI/2),palette.blush,g,0,1.62,0);dome.castShadow=true;
    const domeBand=new THREE.Mesh(new THREE.TorusGeometry(1.45,.06,6,32),palette.white);domeBand.rotation.x=Math.PI/2;domeBand.position.y=1.62;g.add(domeBand);
    // A telescope on the dome creates the recognisable observatory silhouette.
    const telescope=new THREE.Group();telescope.position.set(.08,2.82,.1);telescope.rotation.z=-.55;g.add(telescope);
    cyl(telescope,.14,.19,1.32,palette.purple,0,.48,0,12);telescope.rotation.x=Math.PI/2;
    const lens=ball(telescope,.2,palette.window,0,.48,.66,[1,1,.4]);
    const mount=cyl(g,.18,.27,.58,palette.gold,.08,2.42,.1);const tripod=new THREE.Group();tripod.position.set(.08,2.15,.1);g.add(tripod);for(let i=0;i<3;i++){const leg=box(tripod,.07,.72,.07,palette.gold,Math.cos(i*2.1)*.27,-.31,Math.sin(i*2.1)*.27,.02);leg.rotation.z=Math.cos(i*2.1)*.36;}
    // Front shelves read as a book house from the same viewing angle.
    for(let row=0;row<3;row++){box(g,1.34,.07,.17,palette.white,-.78,.77+row*.38,1.4,.02);for(let i=0;i<4;i++){const book=box(g,.18,.3,.13,i%2?palette.purple:palette.gold,-1.26+i*.31,.93+row*.38,1.43,.018);book.rotation.z=(i-1.5)*.06;}}
    const track=new THREE.Group();track.position.set(0,2.82,0);g.add(track);for(let i=0;i<5;i++){const s=star(track,.1+(i%2)*.035,palette.window,Math.cos(i*1.26)*1.75,Math.sin(i*1.26)*.44,Math.sin(i*1.26)*.34);s.rotation.x=Math.PI/2;}motion.starTracks.push(track);
    const statusOrb=ball(g,.15,palette.mint,0,3.83,0);const halo=new THREE.Mesh(new THREE.TorusGeometry(.31,.028,5,24),palette.rail);halo.rotation.x=Math.PI/2;halo.position.set(0,3.83,0);g.add(halo);
    return registerBuilding(g,{id:'chatgpt',title:'ChatGPT 书屋',g,statusOrb,halo,status:'unknown',kind:'workshop'},4.05);
  }
  function addWarehouse(){
    const g=new THREE.Group();g.position.set(1.5,.42,4.7);land.add(g);
    // The result pavilion remains open on three sides: columns, steps and gift-box canopy.
    box(g,4.1,.22,3.15,palette.cream,0,.11,0,.22);
    for(let i=0;i<3;i++)box(g,2.25-i*.35,.13,.48,palette.white,0,.3-i*.13,1.75+i*.16,.05);
    for(const x of [-1.55,-.52,.52,1.55])cyl(g,.13,.17,2.2,palette.cream,x,1.28,.95,12);
    for(const x of [-1.55,1.55])cyl(g,.13,.17,2.2,palette.cream,x,1.28,-.95,12);
    box(g,3.65,.22,2.75,palette.gold,0,2.45,0,.14);box(g,.28,.27,2.86,palette.pink,0,2.47,0,.04);box(g,3.78,.27,.28,palette.pink,0,2.47,0,.04);
    for(const [x,z,c] of [[-1.02,-.22,palette.pink],[0,-.3,palette.purple],[1.02,-.22,palette.gold]]){const stand=cyl(g,.42,.48,.44,palette.cream,x,.55,z,16);box(g,.55,.42,.44,c,x,.98,z,.07);box(g,.62,.07,.51,palette.white,x,1.22,z,.03);}
    const statusOrb=ball(g,.15,palette.mint,0,3.25,0);const halo=new THREE.Mesh(new THREE.TorusGeometry(.31,.028,5,24),palette.rail);halo.rotation.x=Math.PI/2;halo.position.set(0,3.25,0);g.add(halo);
    return registerBuilding(g,{id:'warehouse',title:'已验收成果',g,statusOrb,halo,status:'idle',kind:'warehouse'},3.47);
  }
  function makeLabel(b,h){
    const el=document.createElement('button');el.type='button';el.className='manor-building-label';el.setAttribute('aria-label',`查看${b.title}`);
    el.style.cssText='position:absolute;transform:translate(-50%,-100%);border:1px solid rgba(139,109,140,.2);border-radius:12px;background:rgba(255,250,241,.95);color:#685568;padding:7px 11px;cursor:pointer;font:500 12px "PingFang SC",sans-serif;box-shadow:0 3px 15px #5a355a12;white-space:nowrap;z-index:2;line-height:1.5;';
    el.textContent=b.title;el.addEventListener('click',()=>{if(b.id==='owner'){focusOwner();return;}onSelect({kind:b.g.userData.kind,id:b.id,title:b.title,filter:b.id});});container.append(el);
    labels.push({el,b,h,view:b.view||b.g.userData.view||'manor'});
  }
  const codexBuilding=addWorkshop();
  const chatBuilding=addObservatory();
  const warehouseBuilding=addWarehouse();
  const greenhouse=new THREE.Group();greenhouse.position.set(6,.42,.05);greenhouse.userData={id:'automation',title:'自动化温室',kind:'automation',filter:'automation'};land.add(greenhouse);destination.set('automation',greenhouse.position.clone());
  box(greenhouse,3.5,.25,3.2,palette.cream,0,.12,0,.2);
  box(greenhouse,3,.65,2.8,palette.mint,0,.52,0,.15);
  box(greenhouse,2.9,1.55,2.7,palette.glass,0,1.52,0,.1);
  for(const x of [-1.43,0,1.43])for(const z of [-1.31,1.31])cyl(greenhouse,.055,.055,1.9,palette.cream,x,1.5,z);
  for(const z of [-1.35,-.45,.45,1.35]){
    const pts=[];for(let i=0;i<=16;i++){const a=Math.PI-i/16*Math.PI;pts.push(new THREE.Vector3(Math.cos(a)*1.45,2.25+Math.sin(a)*.95,z));}tube(pts,.055,palette.cream,greenhouse);
  }
  const dome=mesh(new THREE.CylinderGeometry(1.45,1.45,2.7,24,1,true,0,Math.PI),palette.glass,greenhouse,0,2.25,0,false);dome.rotation.x=Math.PI/2;dome.rotation.z=Math.PI/2;
  box(greenhouse,.8,1.25,.07,palette.cream,0,.98,1.46,.18);
  box(greenhouse,.62,1.05,.08,palette.glass,0,1,1.51,.13);
  for(const x of [-.85,.85])for(const z of [-.7,.55]){cyl(greenhouse,.26,.19,.34,palette.pink,x,.94,z);ball(greenhouse,.32,palette.mint,x,1.35,z,[1,1.4,1]);}
  // Clock, windmill and irrigation make this a working greenhouse even while it is waiting.
  const clockFace=ball(greenhouse,.36,palette.cream,0,2.52,1.43,[1,1,.16]);
  for(let i=0;i<12;i++){const a=i*Math.PI/6;box(greenhouse,.035,.12,.03,palette.dark,Math.sin(a)*.25,2.52+Math.cos(a)*.25,1.5,.008);}
  const clockHand=new THREE.Group();clockHand.position.set(0,2.52,1.53);greenhouse.add(clockHand);box(clockHand,.035,.26,.035,palette.dark,0,.13,0,.01);motion.greenhouseRotor=clockHand;
  const mill=new THREE.Group();mill.position.set(-1.72,2.15,.2);greenhouse.add(mill);cyl(mill,.08,.13,.68,palette.gold,0,-.34,0);
  const rotor=new THREE.Group();mill.add(rotor);for(let i=0;i<4;i++){const blade=box(rotor,.12,.74,.04,palette.white,Math.sin(i*Math.PI/2)*.28,Math.cos(i*Math.PI/2)*.28,0,.02);blade.rotation.z=i*Math.PI/2;}motion.windmills.push(rotor);
  const irrigation=tube([new THREE.Vector3(-1.1,1.75,.8),new THREE.Vector3(0,1.82,.8),new THREE.Vector3(1.1,1.75,.8)],.045,palette.gold,greenhouse);
  for(let i=0;i<4;i++){const drop=ball(greenhouse,.055,palette.water,-.9+i*.6,1.72,.83);drop.visible=false;motion.droplets.push({drop,phase:i/4});}
  const autoOrb=ball(greenhouse,.15,palette.mint,0,3.65,0);
  const ab=registerBuilding(greenhouse,{id:'automation',title:'自动化温室',g:greenhouse,statusOrb:autoOrb,status:'idle',kind:'automation'},3.9);
  greenhouse.visible=false;greenhouse.userData.hidden=true;

  // A separate, rear cloud island is the entry point for observed cloud work. It is intentionally
  // behind the main routes so it never competes with the owner or the four local destinations.
  const cloudStation=new THREE.Group();cloudStation.position.set(-7.15,2.25,5.65);land.add(cloudStation);
  const cloudBase=new THREE.Group();cloudStation.add(cloudBase);
  for(const [x,y,z,s] of [[0,0,0,1],[-.72,-.06,.12,.72],[.78,.02,.08,.8],[.1,.11,-.58,.7]])ball(cloudBase,.9*s,palette.white,x,y,z,[1.55,1,.9]);
  box(cloudStation,2.05,.13,1.22,palette.mint,0,.42,0,.1);
  for(const x of [-.72,.72])cyl(cloudStation,.06,.09,.74,palette.gold,x,.82,0);
  const balloon=new THREE.Group();balloon.position.set(0,1.62,0);cloudStation.add(balloon);
  ball(balloon,.68,palette.purple,0,.55,0,[.9,1.08,.9]);box(balloon,.58,.38,.48,palette.gold,0,-.32,0,.07);
  for(const sx of [-1,1])tube([new THREE.Vector3(sx*.42,.22,0),new THREE.Vector3(sx*.25,-.16,0)],.025,palette.cream,balloon);
  const signal=new THREE.Group();signal.position.set(0,1.42,.18);cloudStation.add(signal);for(let i=0;i<3;i++){const ring=new THREE.Mesh(new THREE.TorusGeometry(.18+i*.16,.018,5,24),palette.rail);ring.rotation.x=Math.PI/2;ring.position.z=i*.006;signal.add(ring);}motion.signals.push(signal);
  const cloudStatus=ball(cloudStation,.13,palette.purple,0,2.55,0);
  registerBuilding(cloudStation,{id:'cloud',title:'云端气球站',g:cloudStation,statusOrb:cloudStatus,status:'unknown',kind:'cloud',filter:'cloud',ambient:true},2.76);
  motion.clouds.push(cloudStation);
  cloudStation.visible=false;cloudStation.userData.hidden=true;

  // Active schedules live among the original manor, rather than in a separate dashboard island.
  const scheduleHomes=new Map(), scheduleLots=new Map(), scheduleMotion=[];
  const schedulePlaces=[[-6.7,-5.1],[5.5,-4.4],[6.2,.5],[6,4.7],[-6.6,4.3]];
  const schedulePaths=[
    [[-6.7,-3.75],[-5.1,-3.75],[-3.5,-2.6],[-3,-.7]],
    [[5.5,-3.05],[3.7,-3.05],[1.3,-2.1]],
    [[6.2,1.85],[4.8,1.85],[3.5,.7]],
    [[6,6.05],[4.2,2.2],[1,2.2]],
    [[-6.6,5.65],[-4.9,5.65],[-3.2,3.2],[-1,2.2],[1,2.2]],
  ];
  for(const path of schedulePaths)for(let i=1;i<path.length;i++){
    const [ax,az]=path[i-1],[bx,bz]=path[i],dx=bx-ax,dz=bz-az;
    const segment=box(land,.62,.055,Math.hypot(dx,dz),pathmat,(ax+bx)/2,.43,(az+bz)/2,.12);segment.rotation.y=Math.atan2(dx,dz);
  }
  function schedulePosition(lot){const p=schedulePlaces[lot.slot]||[-9+(lot.slot%5)*4.5,6+Math.floor((lot.slot-5)/5)*2.4];return new THREE.Vector3(p[0],.42,p[1]);}
  function scheduleLabel(home){
    const el=document.createElement('button');el.type='button';el.className='manor-building-label manor-schedule-label';
    el.setAttribute('aria-label',`查看定时任务：${home.item.title}`);el.title=home.item.title;
    el.style.cssText='position:absolute;transform:translate(-50%,-100%);width:126px;border:1px solid rgba(139,109,140,.25);border-radius:10px;background:rgba(255,250,241,.96);color:#685568;padding:4px 7px;cursor:pointer;font:500 11px/1.3 "PingFang SC",sans-serif;box-shadow:0 2px 10px #5a355a12;white-space:normal;z-index:2;text-align:center;';
    el.addEventListener('click',()=>{selectedId=home.item.id;onSelect({kind:'schedule',id:home.item.id});renderFrame(true);});container.append(el);
    const tooltip=document.createElement('span');tooltip.className='manor-schedule-tooltip';tooltip.hidden=true;tooltip.setAttribute('aria-hidden','true');
    tooltip.style.cssText='position:absolute;left:50%;bottom:calc(100% + 7px);width:154px;padding:6px 8px;border-radius:9px;color:#685568;background:rgba(255,253,248,.97);box-shadow:0 5px 16px rgba(76,48,70,.18);font:500 10px/1.35 "PingFang SC",sans-serif;text-align:left;white-space:normal;transform:translateX(-50%);pointer-events:none;';
    const reveal=()=>{if(!compactMode)return;tooltip.hidden=false;tooltip.style.marginLeft='0px';requestAnimationFrame(()=>{
      if(tooltip.hidden||!compactMode)return;
      const box=tooltip.getBoundingClientRect(),bounds=container.getBoundingClientRect();
      const shift=box.left<bounds.left+5?bounds.left+5-box.left:box.right>bounds.right-5?bounds.right-5-box.right:0;
      tooltip.style.marginLeft=`${shift}px`;
    });};const conceal=()=>{tooltip.hidden=true;tooltip.style.marginLeft='0px';};
    el.addEventListener('mouseenter',reveal);el.addEventListener('mouseleave',conceal);el.addEventListener('focus',reveal);el.addEventListener('blur',conceal);
    if(night){el.style.background='rgba(51,46,74,.96)';el.style.color='#f6e6ee';el.style.borderColor='#7b6a9977';}
    home.label=el;home.tooltip=tooltip;labels.push({el,b:home,h:2.2,view:'manor'});
  }
  function scheduleHome(item,lot){
    const g=new THREE.Group();g.position.copy(schedulePosition(lot));g.scale.setScalar(.72);land.add(g);
    const variant=lot.slot%5, colors=[palette.purple,palette.pink,palette.gold,palette.mint,palette.blush], color=colors[variant];
    const ownedGeometries=[];
    box(g,5.75,.18,3.25,palette.cream,0,.1,0,.18);
    // Each courtyard has the same readable footprint, then one of four distinct silhouettes.
    for(const x of [-2.45,2.45])for(const z of [-1.3,1.3])cyl(g,.055,.07,.5,palette.white,x,.44,z,8);
    box(g,1.45,.05,.72,palette.white,0,.29,1.62,.05);
    // Shared garden details keep every unique silhouette part of the same manor.
    box(g,.58,.78,.06,palette.brown,0,.7,.88,.12);box(g,.34,.42,.04,palette.window,-.82,1.02,.9,.08);box(g,.34,.42,.04,palette.window,.82,1.02,.9,.08);
    for(const x of [-1.95,1.95]){cyl(g,.09,.11,.48,palette.white,x,.52,1.12,8);ball(g,.16,palette.pink,x,.84,1.12);}
    for(const x of [-1.55,1.55]){cyl(g,.16,.12,.18,palette.pink,x,.53,.92,10);ball(g,.19,palette.mint,x,.76,.92,[1,1.25,1]);}
    let spinner=null;
    if(variant===0){
      box(g,2.05,1.65,1.72,color,0,1.15,-.15,.15);const roof=mesh(new THREE.ConeGeometry(1.52,.72,4),palette.white,g,0,2.34,-.15);ownedGeometries.push(roof.geometry);roof.rotation.y=Math.PI/4;
      spinner=new THREE.Group();spinner.position.set(.93,1.15,.77);g.add(spinner);const cog=new THREE.Mesh(new THREE.TorusGeometry(.26,.045,5,14),palette.gold);ownedGeometries.push(cog.geometry);cog.castShadow=true;spinner.add(cog);
    }else if(variant===1){
      cyl(g,1.16,1.28,1.36,color,0,1.02,-.1,18);const dome=mesh(new THREE.SphereGeometry(1.18,18,10,0,Math.PI*2,0,Math.PI/2),palette.blush,g,0,1.69,-.1);ownedGeometries.push(dome.geometry);dome.castShadow=true;
      const scope=new THREE.Group();scope.position.set(0,2.48,-.1);g.add(scope);cyl(scope,.1,.15,.82,palette.gold,0,.23,0,10);scope.rotation.x=Math.PI/2;spinner=scope;
    }else if(variant===2){
      for(const x of [-1.05,0,1.05])cyl(g,.1,.13,1.78,palette.cream,x,1.1,-.12,10);box(g,2.85,.22,1.82,color,0,2.04,-.12,.12);
      const pin=star(g,.27,palette.window,0,1.26,.86);ownedGeometries.push(pin.geometry);spinner=pin;
    }else if(variant===3){
      box(g,2.5,1.26,1.75,palette.glass,0,.95,-.08,.12);const roof=mesh(new THREE.ConeGeometry(1.82,.82,4),color,g,0,1.98,-.08);ownedGeometries.push(roof.geometry);roof.rotation.y=Math.PI/4;
      const vane=new THREE.Group();vane.position.set(1.2,2.2,-.08);g.add(vane);for(let i=0;i<4;i++){const blade=box(vane,.08,.48,.04,palette.white,Math.sin(i*Math.PI/2)*.18,Math.cos(i*Math.PI/2)*.18,0,.01);blade.rotation.z=i*Math.PI/2;}spinner=vane;
    }else{
      box(g,2.45,1.35,1.7,color,0,1,-.1,.18);box(g,2.8,.18,1.95,palette.white,0,1.78,-.1,.08);for(const x of [-.85,.85])cyl(g,.1,.14,1.7,palette.cream,x,1.05,.78,10);spinner=star(g,.23,palette.window,0,2.12,.7);
    }
    const lantern=ball(g,.1,palette.window,-1.9,.78,.9);const marker=ball(g,.11,palette.mint,0,2.72,.1);
    const resultGift=new THREE.Group();resultGift.position.set(1.58,.48,1.08);g.add(resultGift);
    box(resultGift,.42,.34,.36,variant%2?palette.pink:palette.purple,0,0,0,.06);box(resultGift,.47,.07,.41,palette.cream,0,.19,0,.025);box(resultGift,.055,.4,.42,palette.gold,0,0,0,.01);resultGift.visible=false;
    const home={g,item,lot,variant,spinner,lantern,marker,resultGift,status:'unknown',label:null,ownedGeometries};
    g.userData={kind:'schedule',id:item.id,title:item.title,view:'manor'};
    g.traverse(o=>{if(o.isMesh){o.userData.building=g.userData;pickables.push(o);}});
    scheduleMotion.push(home);scheduleLabel(home);return home;
  }
  function removeScheduleHome(home){
    home.g.removeFromParent();home.label?.remove();
    home.ownedGeometries.forEach(geometry=>geometry.dispose());
    const labelIndex=labels.findIndex(l=>l.el===home.label);if(labelIndex>=0)labels.splice(labelIndex,1);
    for(let i=pickables.length-1;i>=0;i--)if(pickables[i].userData.building?.id===home.item.id&&pickables[i].userData.building?.kind==='schedule')pickables.splice(i,1);
    const motionIndex=scheduleMotion.indexOf(home);if(motionIndex>=0)scheduleMotion.splice(motionIndex,1);
  }
  function refreshScheduleVillage(state){
    const items=normalizeVillageAutomations(state);const lots=planVillageLots(items,scheduleLots,5);
    for(const [id,home] of scheduleHomes)if(!lots.has(id)){removeScheduleHome(home);scheduleHomes.delete(id);}
    for(const item of items){
      const lot=lots.get(item.id);let home=scheduleHomes.get(item.id);
      if(!home){home=scheduleHome(item,lot);scheduleHomes.set(item.id,home);}else{home.item=item;home.lot=lot;home.g.position.copy(schedulePosition(lot));home.g.userData.title=item.title;}
      home.status=item.phase;home.marker.material=dotMats[item.phase]||dotMats.unknown;
      const unread=item.unreadResultCount||0;home.resultGift.visible=unread>0;
      home.fullLabel=`${item.title}${unread>0?` · 🎁${unread}`:''}`;
      home.miniLabel=`${item.title} · ${item.statusText}${unread>0?` · 🎁${unread}`:''}`;
      home.label.textContent=home.fullLabel;
      home.tooltip.textContent=`${item.title}\n${item.statusText}${unread>0?` · 待看 ${unread} 份`:''}`;
      home.label.title=`${item.title} · ${item.statusText} · ${item.sourceText}`;home.label.setAttribute('aria-label',`查看定时任务：${item.title}，${item.statusText}，${item.sourceText}${unread>0?`，待看 ${unread} 份`:''}`);
    }
    scheduleLots.clear();for(const [id,lot] of lots)scheduleLots.set(id,lot);
  }

  function refreshCompactBubbles(refreshFailed=false){
    const tasks=compactTaskState(data||{}, {refreshFailed});
    const inbox=compactInboxState(data||{});
    const plans=new Map(compactAutomationState(data||{}).map(item=>[item.id,item]));
    const confirmed=(tasks.running||0)+(tasks.waiting||0);
    codexBuilding.miniLabel=tasks.status==='unavailable'?'Codex\n状态待更新':`Codex 未完成 ${confirmed}\n${tasks.running?'运行 '+tasks.running:''}${tasks.running&&tasks.waiting?' · ':''}${tasks.waiting?'等你 '+tasks.waiting:''}${!confirmed?'当前无已确认进行项':''}${tasks.unknownCount?`\n另 ${tasks.unknownCount} 项未确认`:''}`;
    inboxAnchor.miniLabel=`礼盒 · 待验收 ${inbox.pending}`;
    for(const home of scheduleHomes.values()){
      const plan=plans.get(home.item.id);
      const status=plan?.status||home.item.statusText||'状态未确认';
      const compactStatus=status
        .replace('云端快照 · 暂不可用','云端·待更新')
        .replace('云端快照 · ','云端·')
        .replace('正在运行','运行')
        .replace('等待计划','待计划')
        .replace('已启用','启用')
        .replace('状态未确认','待确认');
      // Lead with the short status: long plan names may ellipsize in mini mode,
      // while title/ARIA retains both complete values for a click or assistive tech.
      home.miniLabel=`${compactStatus} · ${home.item.title}`;
    }
    for(const l of labels){
      if(l.b.item){
        const el=l.el;
        l.b.isMiniMarker=compactMode;
        if(compactMode){
          el.classList.remove('manor-building-label','manor-mini-bubble');el.classList.add('manor-schedule-marker');
          el.replaceChildren(document.createTextNode('✦'),l.b.tooltip);
          el.style.cssText='position:absolute;transform:translate(-50%,-100%);display:grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid rgba(255,255,255,.9);border-radius:50%;color:#755a85;background:rgba(255,253,248,.95);box-shadow:0 3px 10px rgba(76,48,70,.2);cursor:pointer;font:700 12px/1 sans-serif;z-index:4;';
          // A five-second state refresh may rebuild the marker while it is being
          // inspected. Keep its hover/focus tooltip open instead of blinking it away.
        }else{
          el.classList.add('manor-building-label');el.classList.remove('manor-schedule-marker');
          el.replaceChildren(document.createTextNode(l.b.fullLabel||l.b.item.title));
          el.style.cssText='position:absolute;transform:translate(-50%,-100%);width:126px;border:1px solid rgba(139,109,140,.25);border-radius:10px;background:rgba(255,250,241,.96);color:#685568;padding:4px 7px;cursor:pointer;font:500 11px/1.3 "PingFang SC",sans-serif;box-shadow:0 2px 10px #5a355a12;white-space:normal;z-index:2;text-align:center;';
          l.b.tooltip.hidden=true;
        }
        continue;
      }
      const show=compactMode&&(l.b.id==='codex'||l.b.id==='inbox');
      l.el.classList.toggle('manor-mini-bubble',show);
      if(show)l.el.textContent=l.b.miniLabel||l.b.title;
      else l.el.textContent=l.b.label||l.b.title;
    }
  }

  // Transport loop: crates only enter it on a newly observed real completion.
  const railPts=[];for(let i=0;i<48;i++){const a=i/48*Math.PI*2;railPts.push(new THREE.Vector3(Math.cos(a)*9.25,1.05,Math.sin(a)*6.5));}
  const railPath=new THREE.CatmullRomCurve3(railPts,true);
  const rail=mesh(new THREE.TubeGeometry(railPath,128,.065,6,true),palette.rail,land);
  for(let i=0;i<16;i++){const a=i/16*Math.PI*2;cyl(land,.055,.11,.66,palette.cream,Math.cos(a)*9.25,.66,Math.sin(a)*6.5);}
  function tree(x,z,color,size=1){const g=new THREE.Group();g.position.set(x,.33,z);g.scale.setScalar(size);land.add(g);cyl(g,.11,.17,1.1,palette.brown,0,.55,0);ball(g,.65,color,0,1.5,0,[1,1.15,1]);ball(g,.39,color,-.39,1.27,.08);ball(g,.38,color,.35,1.48,.05);}
  for(const [x,z,m,s] of [[-9,-4,palette.pink,1.25],[-9.8,-5.7,palette.mint,.9],[-3.8,-6.5,palette.purple,1],[-1.8,-6.7,palette.mint,.8],[3.7,-6.3,palette.pink,1.05],[9,-5.8,palette.purple,1.2],[9,-2.6,palette.mint,.8],[9.3,3.1,palette.pink,1.2],[8.5,6.2,palette.mint,1.15],[-3.3,6.3,palette.purple,.9],[-9,2.2,palette.mint,.8]])tree(x,z,m,s);
  // Tiny scalloped flower borders, a pond, and a little mailbox.
  function flower(x,z,color){cyl(land,.023,.023,.24,palette.mint,x,.5,z);ball(land,.11,color,x,.69,z);ball(land,.04,palette.gold,x,.78,z);}
  for(let i=0;i<30;i++){const a=i*.86;flower(-8.5+Math.cos(a)*1.35,2.7+Math.sin(a)*.9,i%3===0?palette.purple:palette.pink);}
  const pond=cyl(land,1.25,1.4,.13,palette.cream,-8.5,.4,2.7,40);pond.scale.z=.68;
  const water=cyl(land,1.13,1.13,.04,palette.water,-8.5,.49,2.7,40);water.scale.z=.68;
  for(let i=0;i<3;i++){const lily=cyl(land,.14,.14,.02,palette.mint,-8.6+i*.4,.52,2.55+(i%2)*.24,12);lily.scale.z=.7;ball(land,.07,palette.pink,lily.position.x,.58,lily.position.z);}
  box(land,.85,.08,2.1,palette.cream,-4.2,.5,5.9,.06);
  for(let i=0;i<6;i++)box(land,.8,.035,.08,palette.brown,-4.2,.56,5.05+i*.31,.015);
  for(const [x,z] of [[-3.2,2.7],[3.4,2.8],[-2.7,-3],[4.2,-2.7]]){
    cyl(land,.055,.09,1.25,palette.brown,x,.96,z);ball(land,.19,palette.window,x,1.63,z);cyl(land,.28,0,.18,palette.pink,x,1.88,z);
  }
  const mailbox=new THREE.Group();mailbox.position.set(-1.6,.4,3.6);land.add(mailbox);cyl(mailbox,.07,.1,.75,palette.brown,0,.37,0);box(mailbox,.6,.43,.47,palette.pink,0,.94,0,.15);box(mailbox,.29,.025,.02,palette.dark,0,.99,.245,.006);
  for(let i=0;i<6;i++){const x=-9+i*.64;box(land,.12,.55,.13,palette.white,x,.62,-6.45,.035);if(i<5)box(land,.65,.08,.1,palette.white,x+.32,.76,-6.45,.02);}
  // Static stars become visible after dark.
  const stars=new THREE.Group();land.add(stars);
  for(let i=0;i<24;i++){const a=i*2.399;const s=star(stars,.04+(i%3)*.025,palette.window,Math.cos(a)*(5+i%5),3.5+(i%5)*.65,Math.sin(a)*(4+i%4));s.userData.phase=i;}

  function animal(type,source,x,z){
    const g=new THREE.Group();land.add(g);g.position.set(x,.45,z);
    const skin=type==='rabbit'?palette.white:palette.cream;
    ball(g,.38,skin,0,.52,0,[.85,1,1.1]);
    const head=ball(g,.29,skin,0,.99,.15,[1,1,.95]);
    if(type==='rabbit'){
      for(const sign of [-1,1]){const ear=ball(g,.13,skin,sign*.16,1.4,.12,[.73,2.65,.75]);ear.rotation.z=-sign*.15;ball(g,.08,palette.pink,sign*.16,1.42,.206,[.65,2.45,.45]);}
      ball(g,.13,skin,0,.43,-.42);
    }else{
      for(let i=0;i<9;i++){const a=i/9*Math.PI*2;ball(g,.18,skin,Math.cos(a)*.27,1.03+Math.sin(a)*.2,.05);}
      for(const sign of [-1,1])ball(g,.13,palette.blush,sign*.31,.97,.09,[1.2,.65,.65]);
    }
    for(const sign of [-1,1]){
      ball(g,.034,palette.dark,sign*.1,1.02,.414,[1,1.3,.7]);
      ball(g,.05,palette.pink,sign*.18,.94,.395,[1,.6,.3]);
    }
    ball(g,.035,palette.brown,0,.94,.444,[1,.6,.7]);
    box(g,.44,.33,.1,type==='rabbit'?palette.pink:palette.purple,0,.57,.36,.08);
    const feet=[];for(const sign of [-1,1])feet.push(ball(g,.12,palette.brown,sign*.18,.12,.08,[.8,.7,1.3]));
    const arms=[];for(const sign of [-1,1])arms.push(ball(g,.13,skin,sign*.34,.59,.04,[.8,1.5,.9]));
    const basket=new THREE.Group();basket.position.set(0,.46,.57);g.add(basket);box(basket,.4,.26,.28,palette.gold,0,0,0,.06);box(basket,.43,.045,.31,palette.cream,0,.14,0,.02);basket.visible=false;
    const mark=star(g,.17,palette.gold,0,1.98,0);mark.visible=false;
    g.traverse(o=>{if(o.isMesh){o.userData.building={kind:'animal',id:source,title:type==='rabbit'?'棉棉 · 书屋助手':'团团 · 工坊助手',filter:source};pickables.push(o);}});
    g.scale.setScalar(1.28);
    const a={g,head,feet,arms,basket,mark,source,type,home:new THREE.Vector3(x,.45,z),mode:'idle',phase:source==='codex'?0:2,delivery:0};return a;
  }
  const animals=[animal('sheep','codex',-2.8,3.1),animal('rabbit','chatgpt',4.3,3.1)];
  const inboxAnchor={id:'inbox',title:'待拆礼盒',g:mailbox};
  mailbox.userData={id:'inbox',title:'待拆礼盒',kind:'inbox'};
  const waitingGifts=[];
  for(let i=0;i<6;i++){
    const g=new THREE.Group();land.add(g);
    g.position.set(-2.9+(i%3)*.55,.61+Math.floor(i/3)*.42,4.15);
    box(g,.47,.37,.39,i%2?palette.purple:palette.pink,0,0,0,.07);
    box(g,.51,.07,.43,palette.cream,0,.2,0,.035);
    box(g,.06,.42,.43,palette.gold,0,0,0,.014);
    g.visible=false;waitingGifts.push(g);
    g.traverse(o=>{if(o.isMesh){o.userData.building=mailbox.userData;pickables.push(o);}});
  }
  mailbox.traverse(o=>{if(o.isMesh){o.userData.building=mailbox.userData;pickables.push(o);}});
  makeLabel(inboxAnchor,1.65);
  const crates=[];
  function launchCrate(){
    if(crates.length>=5)return;
    const g=new THREE.Group();land.add(g);box(g,.52,.4,.42,palette.pink,0,0,0,.09);box(g,.57,.08,.47,palette.cream,0,.21,0,.04);box(g,.08,.45,.46,palette.gold,0,0,0,.02);g.position.copy(railPath.getPointAt(0));g.position.y+=.36;crates.push({g,p:0});
  }
  const dotMats={running:material('#81bba4',{emissive:'#5ed5b9',emissiveIntensity:.45}),waiting:material('#f1c472',{emissive:'#ebad4a',emissiveIntensity:.3}),enabled:material('#98cdb7'),completed:palette.mint,history:material('#b9a2d6'),paused:material('#9a8c9d'),stale:material('#b9a2d6'),failed:material('#dc899b'),interrupted:palette.gold,unknown:palette.purple,idle:palette.mint};
  let data=null, seen=new Map(), initialized=false, night=false, paused=window.matchMedia('(prefers-reduced-motion: reduce)').matches, disposed=false, logical=0,last=0,raf=0, frames=0, view='manor', compactMode=false, compactRefreshFailed=false, manorZoom=1.12, compactCamera=null;
  let selectedId=null,transition=null,dirty=true;
  let surfaceVisible=true;
  let ownerAsset=null,ownerGroup=null,ownerMixer=null;
  const ownerPosition=new THREE.Vector3(-1.9,.39,5.9);
  function ownerState(status){container.dispatchEvent(new CustomEvent('owner-avatar-state',{detail:{status}}));}
  async function welcomeOwner(){
    ownerState('loading');
    try{
      const {loadOwnerAvatar}=await import('./owner-avatar.js');
      const asset=await loadOwnerAvatar();
      if(disposed){asset.dispose?.();return;}
      const idleClip=asset.animations?.find(clip=>clip.name.toLowerCase()==='idle')||asset.animations?.find(clip=>clip.name.toLowerCase().includes('idle'));
      if(idleClip){
        ownerMixer=new THREE.AnimationMixer(asset.object);
        ownerMixer.clipAction(idleClip).play();ownerMixer.update(0);
      }
      asset.object.updateMatrixWorld(true);
      asset.object.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update();});
      const bounds=new THREE.Box3().setFromObject(asset.object,true);
      const size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
      if(!Number.isFinite(size.y)||size.y<=0){asset.dispose?.();throw new Error('The avatar has no visible geometry.');}
      ownerAsset=asset;
      // Offset in a parent so the original root transforms and animation tracks remain intact.
      ownerGroup=new THREE.Group();ownerGroup.position.copy(ownerPosition);land.add(ownerGroup);
      ownerGroup.userData={id:'owner',title:'庄园主人',kind:'owner'};
      const scaleGroup=new THREE.Group(),offset=new THREE.Group();
      scaleGroup.scale.setScalar(2.8/size.y);
      offset.position.set(-center.x,-bounds.min.y,-center.z);
      offset.add(asset.object);scaleGroup.add(offset);ownerGroup.add(scaleGroup);
      ownerGroup.rotation.y=.45;
      asset.object.traverse(o=>{if(o.isMesh){o.userData.building=ownerGroup.userData;pickables.push(o);}});
      if(idleClip?.duration<=.1)ownerMixer.timeScale=0;
      const ownerLabel={id:'owner',title:'♡ 庄园主人',g:ownerGroup};makeLabel(ownerLabel,3.25);
      setTheme(night?'night':'day');
      renderer.domElement.setAttribute('aria-label','星糖庄园 3D 场景，含你的庄园主人形象。可拖动旋转、滚轮缩放，点击找到我拉近查看人物。');
      ownerState('ready');dirty=true;renderFrame(true);
    }catch(error){if(!disposed){ownerState('error');console.warn('庄园主人暂时无法加载。',error);}}
  }
  function focusOwner(){
    if(view!=='manor')setView('manor');
    if(!ownerGroup)return;
    selectedId='owner';transition=null;
    controls.target.copy(ownerPosition).add(new THREE.Vector3(0,1.3,0));
    camera.position.copy(controls.target).add(new THREE.Vector3(7,5.5,13));
    camera.zoom=2.7;camera.updateProjectionMatrix();controls.update();renderFrame(true);
  }
  function setData(state){
    state=state||{};data=state;const tasks=Array.isArray(state.tasks)?state.tasks:[];
    for(const b of buildings){
      let active=0,waiting=0;
      if(b.id==='automation'){
        const plans=(Array.isArray(state.automations)?state.automations:[]).filter(a=>a.cloud!==true);
        const running=plans.filter(a=>a.executionStatus==='running').length;
        const queued=plans.filter(a=>a.executionStatus==='waiting').length;
        const enabled=plans.filter(a=>a.status==='ACTIVE').length;
        const pausedPlans=plans.filter(a=>a.status==='PAUSED').length;
        active=running;waiting=queued||(!running&&enabled)?enabled:0;
        b.status=running?'running':waiting?'waiting':pausedPlans?'idle':'unknown';
        b.detail=running?`${b.title} · ${running} 项正在运行`:waiting?`${b.title} · 等待下一次计划`:pausedPlans?`${b.title} · 计划已暂停`:`${b.title} · 暂无计划快照`;
        b.label=b.title;
      }else if(b.id==='warehouse'){
        const results=state.inbox?.acceptedCount||0;
        b.detail=`${b.title} · ${results} 份已验收`;b.label=`成果馆 · ${results}`;b.status=results?'completed':'idle';
      }else if(b.id==='cloud'){
        const sync=state.cloudSync||{};
        const cloudPlans=(Array.isArray(state.automations)?state.automations:[]).filter(a=>a.cloud===true);
        active=tasks.filter(t=>t.cloud===true&&t.status==='running').length+cloudPlans.filter(a=>a.executionStatus==='running').length;
        b.status=active?'running':sync.available===true&&!sync.stale?'idle':'unknown';
        b.detail=active?`${b.title} · ${active} 项云端运行中`:sync.available===true&&!sync.stale?`${b.title} · 已观测云端快照`:sync.stale?`${b.title} · 云端记录已过期`:`${b.title} · 暂无云端快照`;
        b.label=b.title;
      }else{
        const group=tasks.filter(t=>t.source===b.id);active=group.filter(t=>t.status==='running').length;waiting=group.filter(t=>t.status==='waiting').length;
        b.status=active?'running':waiting?'waiting':b.id==='chatgpt'?'unknown':'idle';
        b.detail=`${b.title} · ${active?active+' 个忙碌':waiting?waiting+' 个待处理':b.id==='chatgpt'?'目录快照':'休息中'}`;
        b.label=b.id==='codex'?'Codex 工坊':'ChatGPT 书屋';
      }
      b.statusOrb.material=dotMats[b.status]||dotMats.unknown;
      b.activeCount=active;b.waitingCount=waiting;
    }
    refreshScheduleVillage(state);
    for(const a of animals){const group=tasks.filter(t=>t.source===a.source);a.mode=group.some(t=>t.status==='waiting')?'waiting':group.some(t=>t.status==='running')?'running':'idle';a.mark.visible=a.mode==='waiting';}
    const pending=state.inbox?.pendingCount||0;
    inboxAnchor.detail=`待拆礼盒 · ${pending} 份待验收`;inboxAnchor.label=`礼盒 · ${pending}`;
    waitingGifts.forEach((gift,i)=>{gift.visible=i<Math.min(pending,waitingGifts.length);});
    for(const result of state.inbox?.items||[]){
      const prior=seen.get(result.id);
      if(initialized&&prior&&prior!=='accepted'&&result.status==='accepted'){
        launchCrate();const a=animals.find(a=>a.source===result.source);if(a)a.delivery=14;
      }
      seen.set(result.id,result.status);
    }
    initialized=true;
    refreshCompactBubbles(compactRefreshFailed);
    for(const l of labels)if(!l.b.item){l.el.title=l.b.detail||l.b.label||l.b.title;}
    renderFrame(true);
  }
  function setTheme(theme){
    night=theme==='night';scene.background=new THREE.Color(night?'#24243e':'#f0e5eb');scene.fog=new THREE.Fog(scene.background,45,100);
    floor.material.color.set(night?'#29283f':'#eadde7');
    hemi.color.set(night?'#b8c4fa':'#fff7ee');hemi.groundColor.set(night?'#604b7d':'#c9b1ce');hemi.intensity=night?1.15:1.85;
    sun.color.set(night?'#adb8ff':'#ffeddc');sun.intensity=night?1.5:2.3;
    rim.intensity=night?2.4:1.1;palette.window.emissiveIntensity=night?2.2:.16;palette.rail.emissiveIntensity=night?2.7:.13;stars.visible=night;
    for(const l of labels){l.el.style.background=night?'rgba(51,46,74,.96)':'rgba(255,250,241,.95)';l.el.style.color=night?'#f6e6ee':'#685568';l.el.style.borderColor=night?'#7b6a9977':'rgba(139,109,140,.2)';}
    renderFrame(true);
  }
  function setPaused(v){paused=!!v;renderFrame(true);}
  function setDreamMode(enabled){
    manorPlinth.forEach(layer=>{layer.visible=!enabled;});floor.visible=!enabled;dreamIsland.visible=enabled;
  }
  function setCompactMode(next){
    const enabled=!!next;
    if(enabled!==compactMode){
      if(enabled){
        compactCamera={position:camera.position.clone(),target:controls.target.clone(),zoom:camera.zoom};
        transition=null;camera.position.copy(compactHome);controls.target.set(0,-1,0);camera.zoom=.9;
      }else if(compactCamera){
        camera.position.copy(compactCamera.position);controls.target.copy(compactCamera.target);camera.zoom=compactCamera.zoom;compactCamera=null;
      }else camera.zoom=manorZoom;
      camera.updateProjectionMatrix();controls.update();
    }
    compactMode=enabled;setDreamMode(compactMode);container.dataset.compactMode=compactMode?'true':'false';refreshCompactBubbles(compactRefreshFailed);dirty=true;renderFrame(true);
  }
  function setCompactRefreshFailed(next){compactRefreshFailed=!!next;refreshCompactBubbles(compactRefreshFailed);dirty=true;renderFrame(true);}
  function setVisible(v){surfaceVisible=!!v;last=performance.now();if(surfaceVisible){dirty=true;renderFrame(true);}}
  function applyView(nextView,resetCamera=false){
    if(!resetCamera){view='manor';dirty=true;renderFrame(true);return;}
    view='manor';selectedId=null;transition=null;controls.enablePan=false;controls.minZoom=.7;
    camera.position.copy(home);camera.zoom=1.12;controls.target.set(0,1,0);
    camera.updateProjectionMatrix();controls.update();dirty=true;renderFrame(true);
  }
  function setView(nextView){applyView(nextView,false);}
  function focusAutomation(id){
    const scheduleHome=scheduleHomes.get(id);if(!scheduleHome)return false;
    selectedId=id;
    const target=compactMode
      ? new THREE.Vector3(scheduleHome.g.position.x*.18,-.8,scheduleHome.g.position.z*.18)
      : scheduleHome.g.position.clone().add(new THREE.Vector3(0,.8,0));
    transition={from:controls.target.clone(),to:target,t:0};dirty=true;renderFrame(true);return true;
  }
  function focusBuilding(id){if(scheduleHomes.has(id))return focusAutomation(id);const p=destination.get(id);if(!p)return false;if(view!=='manor')setView('manor');selectedId=id;transition={from:controls.target.clone(),to:p.clone().add(new THREE.Vector3(0,1,0)),t:0};renderFrame(true);return true;}
  function resetView(){
    if(compactMode){
      selectedId=null;transition=null;camera.position.copy(compactHome);camera.zoom=.9;controls.target.set(0,-1,0);
      camera.updateProjectionMatrix();controls.update();dirty=true;renderFrame(true);return;
    }
    applyView(view,true);
  }
  const vector=new THREE.Vector3();
  function updateLabels(){
    const w=container.clientWidth,h=container.clientHeight;
    const visible=[];
    for(const l of labels){
      const miniEligible=l.b.id==='codex'||l.b.id==='inbox'||l.b.item;
      if(compactMode&&!miniEligible){l.el.classList.add('is-projected-hidden');continue;}
      l.b.g.getWorldPosition(vector);vector.y+=l.h;vector.project(camera);
      const inView=l.view===view&&l.b.g.visible!==false&&vector.z<1&&vector.x>-.99&&vector.x<.99&&vector.y>-.99&&vector.y<.99;
      const labelId=l.b.id||l.b.item?.id;
      l.el.style.outline=selectedId===labelId?'2px solid #b998cc':'none';
      if(!inView){l.el.classList.add('is-projected-hidden');if(l.b.isMiniMarker)l.el.style.display='none';continue;}
      // Make the element measurable before placing it; its visibility prevents a visible jump.
      l.el.classList.remove('is-projected-hidden');l.el.style.display=l.b.isMiniMarker?'grid':'block';l.el.style.visibility='hidden';
      visible.push({l,x:(vector.x+1)*w/2,y:(-vector.y+1)*h/2,id:labelId});
    }
    const priority=entry=>compactMode?(entry.id==='codex'?6:entry.id==='inbox'?5:entry.l.b.item?4:1):(entry.l.b.item?4:entry.id==='owner'?3:entry.id==='inbox'||entry.id==='warehouse'?2:1);
    visible.sort((a,b)=>priority(b)-priority(a)||a.y-b.y);
    const occupied=compactMode?[{x:w-112,y:0,w:112,h:45}]:[];const intersects=(a,b)=>a.x<b.x+b.w+6&&a.x+a.w+6>b.x&&a.y<b.y+b.h+6&&a.y+a.h+6>b.y;
    for(const entry of visible){
      const {l}=entry, width=l.el.offsetWidth||126,labelHeight=l.el.offsetHeight||30;
      const cached=l.offset||[0,0];const options=[cached,[0,0],[0,-34],[72,-12],[-72,-12],[72,26],[-72,26],[0,38],[108,-28],[-108,-28]];
      let placed=null;
      for(const [dx,dy] of options){
        const x=Math.max(width/2+4,Math.min(w-width/2-4,entry.x+dx));
        const y=Math.max(labelHeight+4,Math.min(h-4,entry.y+dy));
        const rect={x:x-width/2,y:y-labelHeight,w:width,h:labelHeight};
        if(!occupied.some(other=>intersects(rect,other))){placed={x,y,rect,offset:[x-entry.x,y-entry.y]};break;}
      }
      // Several active courtyards can project into the same small area. For the
      // compact town, search the canvas for the closest free slot instead of
      // forcing a last overlapping label at its original projection.
      if(!placed&&compactMode){
        let best=null,bestDistance=Infinity;
        const step=8;
        for(let y=labelHeight+4;y<=h-4;y+=step)for(let x=width/2+4;x<=w-width/2-4;x+=step){
          const rect={x:x-width/2,y:y-labelHeight,w:width,h:labelHeight};
          if(occupied.some(other=>intersects(rect,other)))continue;
          const distance=(x-entry.x)**2+(y-entry.y)**2;
          if(distance<bestDistance){best={x,y,rect,offset:[x-entry.x,y-entry.y]};bestDistance=distance;}
        }
        placed=best;
      }
      if(!placed){const x=Math.max(width/2+4,Math.min(w-width/2-4,entry.x));const y=Math.max(labelHeight+4,Math.min(h-4,entry.y-54-occupied.length*2));placed={x,y,rect:{x:x-width/2,y:y-labelHeight,w:width,h:labelHeight},offset:[x-entry.x,y-entry.y]};}
      l.offset=placed.offset;l.el.style.left=placed.x+'px';l.el.style.top=placed.y+'px';l.el.style.visibility='visible';occupied.push(placed.rect);
    }
  }
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();let down=null;
  function pointerDown(e){down=[e.clientX,e.clientY];}
  function pointerUp(e){if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>6)return;down=null;const r=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);raycaster.setFromCamera(pointer,camera);const hits=raycaster.intersectObjects(pickables,false);const hit=hits.find(candidate=>(candidate.object.userData.building?.view||'manor')===view&&!candidate.object.userData.building?.hidden);if(hit?.object.userData.building){const d=hit.object.userData.building;if(d.id==='owner'){focusOwner();return;}selectedId=d.id;onSelect(d);renderFrame(true);}}
  renderer.domElement.addEventListener('pointerdown',pointerDown);renderer.domElement.addEventListener('pointerup',pointerUp);
  function resize(){const w=container.clientWidth||800,h=container.clientHeight||580;renderer.setSize(w,h,false);const aspect=w/h;const vertical=aspect<1.1?25/aspect:20;camera.left=-vertical*aspect/2;camera.right=vertical*aspect/2;camera.top=vertical/2;camera.bottom=-vertical/2;camera.updateProjectionMatrix();renderFrame(true);}
  const resizeObserver=new ResizeObserver(resize);resizeObserver.observe(container);
  function animateWorld(dt){
    logical+=dt;
    if(ownerMixer?.timeScale)ownerMixer.update(dt);
    centerStar.rotation.y=logical*.5;centerStar.position.y=1.7+Math.sin(logical*1.8)*.06;ring.rotation.z=logical*.2;
    for(const b of buildings){if(b.halo){b.halo.rotation.z=logical;const s=b.status==='running'?1+Math.sin(logical*3)*.12:1;b.halo.scale.setScalar(s);}}
    const workshopRunning=codexBuilding.status==='running';
    const greenhouseRunning=ab.status==='running';
    const cloudRunning=buildings.find(b=>b.id==='cloud')?.status==='running';
    // Environmental movement is deliberately calm; visible production movement requires a real running state.
    motion.windmills.forEach((mill,i)=>{mill.rotation.z=logical*(.16+i*.02);});
    motion.starTracks.forEach((track,i)=>{track.rotation.y=logical*(.13+i*.02);});
    motion.clouds.forEach((cloud,i)=>{cloud.position.y=2.25+Math.sin(logical*.42+i)*.12;});
    if(motion.greenhouseRotor)motion.greenhouseRotor.rotation.z=logical*.05;
    motion.gears.forEach((g,i)=>{g.rotation.z=workshopRunning?logical*(1.8+i*.18)*(i%2?1:-1):0;});
    motion.belts.forEach(({parcel,phase})=>{parcel.position.x=workshopRunning?-.95+((logical*.85+phase)%1)*2.05:-.85+phase*.8;});
    motion.workLights.forEach(({light,phase,baseY})=>{const pulse=workshopRunning?(Math.sin(logical*4+phase*6.28)+1)/2:0;light.position.y=baseY+pulse*.38;light.scale.setScalar(workshopRunning?.8+pulse*.55:.5);});
    motion.droplets.forEach(({drop,phase})=>{drop.visible=greenhouseRunning;if(greenhouseRunning){const fall=(logical*.7+phase)%1;drop.position.y=1.82-fall*.76;drop.scale.setScalar(.65+fall*.35);}});
    motion.signals.forEach((signal,i)=>{const pulse=cloudRunning?1+Math.sin(logical*3+i)*.18:1;signal.scale.setScalar(pulse);signal.rotation.z=cloudRunning?logical*.55:0;});
    if(dreamIsland.visible){
      dreamClouds.forEach(({cloud,baseY,phase})=>{cloud.position.y=baseY+Math.sin(logical*.38+phase)*.09;});
      dreamStars.forEach(({sparkle,phase})=>{const pulse=.78+Math.sin(logical*1.15+phase)*.2;sparkle.scale.setScalar(pulse);sparkle.rotation.z=logical*.35+phase;});
    }
    for(const home of scheduleMotion){
      const running=home.status==='running';
      if(running&&home.spinner)home.spinner.rotation.z+=dt*(1.1+home.variant*.16);
      const pulse=running?(Math.sin(logical*4+home.lot.slot)+1)/2:0;
      home.lantern.scale.setScalar(running?.85+pulse*.45:.62);
      home.marker.scale.setScalar(running?1+pulse*.22:1);
    }
    for(const a of animals){
      const t=logical+a.phase;let walk=false;
      if(a.delivery>0){
        a.delivery-=dt;a.basket.visible=true;const progress=1-a.delivery/14;const p=a.home.clone().lerp(new THREE.Vector3(1.5,.45,6.5),Math.sin(progress*Math.PI));a.g.position.copy(p);a.g.rotation.y=progress<.5?.7:-2.4;walk=true;
      }else if(a.mode==='running'){
        a.basket.visible=false;const f=(Math.sin(t*.45)+1)/2;const start=a.home,end=a.source==='codex'?new THREE.Vector3(-5.4,.45,.1):new THREE.Vector3(.6,.45,-2.7);a.g.position.lerpVectors(start,end,f);a.g.rotation.y=Math.cos(t*.45)>0?-2.4:.7;walk=true;
      }else{
        a.basket.visible=false;a.g.position.lerp(a.home,Math.min(dt*3,1));a.g.rotation.y=.15+Math.sin(t*.5)*.1;
      }
      a.g.position.y=.45+(walk?Math.abs(Math.sin(t*8))*.07:Math.sin(t*1.8)*.015);
      a.feet.forEach((foot,i)=>foot.rotation.x=walk?Math.sin(t*8+i*Math.PI)*.5:0);
      a.arms.forEach((arm,i)=>arm.rotation.x=walk?Math.sin(t*8+i*Math.PI)*.35:Math.sin(t*.9)*.05);
      a.mark.rotation.y=t*.7;
    }
    for(let i=crates.length-1;i>=0;i--){const c=crates[i];c.p+=dt/15;if(c.p>=1){land.remove(c.g);crates.splice(i,1);}else{const p=railPath.getPointAt(c.p);c.g.position.copy(p);c.g.position.y+=.36;const tangent=railPath.getTangentAt(c.p);c.g.rotation.y=Math.atan2(tangent.x,tangent.z);}}
    if(night)stars.children.forEach((s,i)=>{s.scale.setScalar(.75+Math.sin(logical*1.2+i)*.25);s.rotation.y=logical*.2;});
  }
  function renderFrame(force=false){
    if(disposed||(!surfaceVisible&&!force))return;
    if(transition){transition.t=Math.min(1,transition.t+.06);controls.target.lerpVectors(transition.from,transition.to,1-Math.pow(1-transition.t,3));if(transition.t===1)transition=null;}
    controls.update();camera.updateMatrixWorld(true);renderer.render(scene,camera);updateLabels();frames++;dirty=false;
  }
  function tick(now){
    if(disposed)return;raf=requestAnimationFrame(tick);
    if(document.hidden||!surfaceVisible){last=now;return;}
    const elapsed=now-last;if(elapsed<33)return;const dt=Math.min(elapsed/1000,.1);last=now;
    if(!paused)animateWorld(dt);
    if(!paused||transition||dirty||frames<2)renderFrame();
  }
  controls.addEventListener('change',()=>{dirty=true;});
  // A dirty flag avoids controls.update -> change recursion when animations pause.
  const rawSetPaused=setPaused;
  function pause(v){controls.enableDamping=!v;rawSetPaused(v);}
  function dispose(){disposed=true;cancelAnimationFrame(raf);resizeObserver.disconnect();controls.dispose();renderer.domElement.removeEventListener('pointerdown',pointerDown);renderer.domElement.removeEventListener('pointerup',pointerUp);ownerMixer?.stopAllAction();if(ownerAsset)ownerMixer?.uncacheRoot(ownerAsset.object);ownerGroup?.removeFromParent();ownerAsset?.dispose?.();const gs=new Set(),ms=new Set();scene.traverse(o=>{if(o.geometry)gs.add(o.geometry);if(o.material){(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>ms.add(m));}});gs.forEach(g=>g.dispose());ms.forEach(m=>m.dispose());renderer.dispose();renderer.domElement.remove();labels.forEach(l=>l.el.remove());}
  setTheme('day');resize();raf=requestAnimationFrame(tick);welcomeOwner();
  return {setData,setTheme,setPaused:pause,setVisible,setCompactMode,setCompactRefreshFailed,setView,focusBuilding,focusAutomation,focusOwner,resetView,dispose};
}
