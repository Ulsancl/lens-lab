import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { DEFAULT_CONFIG, solveOptics, traceRay } from '../src/physics.js';
import { makeProjection, makeTarget } from '../src/projection.js';
import { createProject, serializeProject } from '../src/project.js';

const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'output/browser-integration');
await fs.mkdir(output,{recursive:true});
const server=await createServer({root,server:{host:'127.0.0.1',port:5221,strictPort:true,hmr:false}});await server.listen();
const hardware=process.env.LENS_BROWSER_HARDWARE==='1';
const browser=await chromium.launch({headless:true,...(hardware?{args:['--enable-gpu','--use-angle=d3d11','--ignore-gpu-blocklist']}:{})});
const context=await browser.newContext({viewport:{width:1600,height:1100},acceptDownloads:true}),page=await context.newPage();
page.setDefaultTimeout(20000);
const checks=[],errors=[],externalRequests=[];let gpu,failure;
function watch(p){p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});p.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).hostname!=='127.0.0.1')externalRequests.push(r.url());});}watch(page);
const check=async(name,fn)=>{await fn();checks.push(name);console.log(`PASS ${name}`);};
const current=()=>page.evaluate(()=>window.lensLab.getState());
const project=()=>page.evaluate(()=>window.lensLab.project());
const guide=()=>page.evaluate(()=>window.lensLab.guide());
const debug=()=>page.evaluate(()=>window.lensLab.sceneDebug());
const load=value=>page.evaluate(raw=>window.lensLab.loadProject(raw),serializeProject(value));
const choose=id=>page.locator(`[data-lesson="${id}"]`).click();
async function input(id,value){await page.locator(`#${id}`).fill(String(value));await page.locator(`#${id}`).press('Tab');}
const near=(a,b,tol=1e-8)=>assert.ok(Math.abs(a-b)<=tol,`${a} != ${b}`);
function hash(bytes){let value=2166136261;for(const byte of bytes)value=Math.imul(value^byte,16777619)>>>0;return value;}
async function canvasPixels(){return page.locator('#screen-preview').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data));}
const paint=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function sceneParity(){
  const {config,solution}=await current(),actual=await debug(),r=config.apertureDiameterMm/2;
  near(actual.objectX,-config.objectDistanceMm/1000);near(actual.screenX,config.screenDistanceMm/1000);near(actual.apertureRadiusM,r/1000);
  assert.equal(actual.screenTexture.checksum,hash(makeProjection(solution).rgba).toString(16).padStart(8,'0'));assert.equal(actual.targetTexture.checksum,hash(makeTarget().rgba).toString(16).padStart(8,'0'));assert.equal(actual.screenTexture.flipY,false);assert.deepEqual(actual.screenUv,[0,0,0,1,1,1,1,0]);
  const expected=[];for(const point of[{horizontalMm:0,verticalMm:3},{horizontalMm:3.25,verticalMm:2.25}])for(const pupil of[{horizontalMm:0,verticalMm:0},{horizontalMm:r*.8,verticalMm:r*.6},{horizontalMm:-r*.8,verticalMm:-r*.6}]){const ray=traceRay(config,point,pupil);expected.push(['object','pupil','screen'].map(key=>[ray[key].xMm/1000,.13+ray[key].yMm/1000,ray[key].zMm/1000].map(Math.fround)));}
  assert.deepEqual(actual.rays,expected);
}
try{
  await page.goto('http://127.0.0.1:5221/');await page.waitForFunction(()=>window.lensLab?.sceneDebug()?.ready);
  await check('offline optical bench starts with fourteen parts and a real static WebGL scene',async()=>{
    assert.equal((await debug()).componentCount,14);assert.deepEqual((await current()).config,DEFAULT_CONFIG);assert.equal(await page.locator('#play').count(),0);
    gpu=await page.evaluate(()=>{const gl=document.querySelector('#scene canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return{webgl2:!!gl,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};});
    if(hardware)assert.match(gpu.renderer,/RTX 5080.*D3D11|D3D11.*RTX 5080/);
    await page.waitForTimeout(120);const before=await debug();await page.waitForTimeout(180);assert.equal((await debug()).renderFrame,before.renderFrame);
  });
  await check('numeric edits and keyboard ranges produce the exact common thin-lens solution and projection pixels',async()=>{
    await input('screen-distance',300);let result=await current();assert.deepEqual(result.solution,solveOptics(result.config));assert.equal(result.solution.image.distanceMm,300);assert.equal(result.solution.image.magnification,-1);near(result.solution.screen.blurRadiusMm,0);
    const expected=makeProjection(result.solution,{size:192});assert.deepEqual(await canvasPixels(),Array.from(expected.rgba));await sceneParity();
    await page.locator('[data-range="screenDistanceMm"]').focus();await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>window.lensLab.getState().config.screenDistanceMm===301);assert.equal(await page.locator('#screen-distance').inputValue(),'301');
    await input('screen-distance',300.125);assert.equal((await current()).config.screenDistanceMm,300.125);
  });
  await check('pending slider updates cannot overwrite subsequent numeric or form edits',async()=>{
    for(const submit of[false,true]){await page.evaluate(submit=>{const range=document.querySelector('[data-range="screenDistanceMm"]'),number=document.querySelector('#screen-distance');range.value='320';range.dispatchEvent(new Event('input',{bubbles:true}));number.value='500';if(submit)document.querySelector('#settings-form').requestSubmit();else number.dispatchEvent(new Event('change',{bubbles:true}));},submit);await paint();assert.equal((await current()).config.screenDistanceMm,500);}
  });
  await check('real, parallel and virtual image states retain finite screen rays and honest screen projection',async()=>{
    for(const[u,kind,v,m]of[[225,'real',450,-2],[150,'infinity',null,null],[100,'virtual',-300,3]]){
      await input('object-distance',u);const result=await current();assert.equal(result.solution.image.kind,kind);assert.equal(result.solution.image.distanceMm,v);assert.equal(result.solution.image.magnification,m);
      const expected=makeProjection(solveOptics(result.config),{size:192});assert.equal(hash(await canvasPixels()),hash(expected.rgba));assert.ok(!/NaN|undefined/.test(await page.locator('.metrics').innerText()));await sceneParity();
      await page.locator('#scene').screenshot({path:path.join(output,`image-${kind}.png`)});
    }
    assert.match(await page.locator('#screen-explanation').textContent(),/허상.*선명한 투영이 아닙니다/);
  });
  await check('smaller aperture preserves focus geometry, reduces blur and keeps fixed exposure and comparison settings',async()=>{
    await load(createProject({config:{...DEFAULT_CONFIG,screenDistanceMm:320}}));await page.locator('#pin-comparison').click();const before=await current(),bright=await canvasPixels();
    await input('aperture',6);const after=await current();near(before.solution.screen.blurRadiusMm,.6);near(after.solution.screen.blurRadiusMm,.2);near(after.solution.light.collectedRelative,1/9);assert.equal(after.solution.image.distanceMm,before.solution.image.distanceMm);assert.deepEqual(after.comparison.config,before.config);
    const sum=bytes=>bytes.reduce((total,value,index)=>total+(index%4===0?value:0),0);assert.ok(sum(await canvasPixels())<sum(bright));
  });
  await check('saved and current projections share raster resolution and physical display scale',async()=>{
    const before=await project(),box=await page.locator('#screen-preview').boundingBox();await page.locator('#show-saved').click();assert.equal(await page.locator('#screen-preview').isVisible(),false);const savedBox=await page.locator('#comparison-preview').boundingBox();assert.equal(savedBox.width,box.width);assert.equal(savedBox.height,box.height);
    const bytes=await page.locator('#comparison-preview').evaluate(canvas=>({width:canvas.width,height:canvas.height,rgba:Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data)}));assert.equal(bytes.width,192);assert.equal(bytes.height,192);assert.deepEqual(bytes.rgba,Array.from(makeProjection(solveOptics(before.comparison.config)).rgba));assert.deepEqual(await project(),before);assert.match(await page.locator('#projection-state').textContent(),/보관한 조건/);await page.screenshot({path:path.join(output,'saved-comparison.png'),fullPage:true});
    await page.locator('#show-current').click();assert.equal(await page.locator('#screen-preview').isVisible(),true);assert.equal(await page.locator('#comparison-preview').isVisible(),false);await page.locator('#show-saved').click();await input('screen-distance',321);assert.equal(await page.locator('#screen-preview').isVisible(),true);assert.deepEqual((await project()).comparison,before.comparison);
  });
  await check('focus lesson requires the actual optical condition and freezes completed evidence',async()=>{
    await choose('focus');assert.equal(await page.locator('#guide-next').isEnabled(),false);await input('screen-distance',300);assert.equal(await page.locator('#guide-next').isEnabled(),true);await page.locator('#guide-next').click();assert.equal((await guide()).status,'completed');
    const evidence=await guide(),result=await page.locator('#guide-result').textContent();await input('screen-distance',390);assert.deepEqual((await guide()).evidence,evidence.evidence);assert.equal(await page.locator('#guide-result').textContent(),result);
  });
  await check('image lesson observes magnified real image, infinity and upright virtual image in order',async()=>{
    await choose('image');await input('object-distance',225);assert.equal(await page.locator('#guide-next').isEnabled(),false);await input('screen-distance',450);await page.locator('#guide-next').click();assert.equal((await guide()).stage,1);
    await input('object-distance',150.0005);assert.equal((await current()).solution.image.kind,'real');assert.equal(await page.locator('#guide-next').isEnabled(),false);
    await input('object-distance',150);await page.locator('#guide-next').click();assert.equal((await guide()).stage,2);await input('object-distance',100);await page.locator('#guide-next').click();assert.equal((await guide()).status,'completed');assert.equal((await guide()).evidence.observed.length,3);
  });
  await check('aperture lesson retains its own baseline despite independent comparison edits',async()=>{
    await choose('aperture');await input('aperture',6);await page.locator('#pin-comparison').click();await page.locator('#clear-comparison').click();await page.locator('#guide-next').click();assert.equal((await guide()).stage,1);
    await input('screen-distance',300);await page.locator('#guide-next').click();const result=await guide();assert.equal(result.status,'completed');assert.equal(result.evidence.baseline.apertureDiameterMm,18);assert.equal(result.evidence.observed[0].screenDistanceMm,320);assert.equal(result.evidence.config.screenDistanceMm,300);
  });
  await check('incompatible manual edits interrupt lessons and undo restores the full previous experiment',async()=>{
    await choose('focus');await input('object-distance',330);assert.equal((await guide()).status,'interrupted');const before=await project(),priorGuide=await guide();await page.locator('#new-project').click();await page.locator('#undo-new').click();assert.deepEqual((await project()).config,before.config);assert.deepEqual(await guide(),priorGuide);
    await page.getByRole('button',{name:'알림 닫기'}).click();assert.equal(await page.locator('#toast').isVisible(),false);
  });
  await check('part selection and resizing preserve camera while explicit focus, layers and large view are reversible',async()=>{
    await page.locator('#guide-exit').click();const camera=(await project()).observation.camera;await page.locator('#part-select').selectOption('lens-glass');assert.deepEqual((await project()).observation.camera,camera);
    await page.setViewportSize({width:1280,height:900});assert.deepEqual((await project()).observation.camera,camera);await page.locator('#focus-part').click();assert.notDeepEqual((await project()).observation.camera,camera);
    const before=(await current()).config;for(const key of['rays','focus','structure','labels']){const box=page.locator(`[data-view="${key}"]`),value=await box.isChecked();await box.setChecked(!value);await box.setChecked(value);}assert.deepEqual((await current()).config,before);
    await page.locator('#focus').click();assert.equal(await page.locator('.controls').isVisible(),false);await page.locator('#focus').click();assert.equal(await page.locator('.controls').isVisible(),true);
  });
  await check('download, validated import and reload preserve config, comparison and observation without a hidden clock',async()=>{
    await page.locator('#pin-comparison').click();const saved=await project(),pending=page.waitForEvent('download');await page.locator('#save-project').click();const download=await pending,file=path.join(output,'saved.lens.json');await download.saveAs(file);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),saved);
    await page.locator('#new-project').click();await page.locator('#project-file').setInputFiles(file);await page.waitForFunction(config=>JSON.stringify(window.lensLab.getState().config)===JSON.stringify(config),saved.config);assert.deepEqual((await project()).comparison,saved.comparison);assert.deepEqual((await project()).observation,saved.observation);
    await page.reload();await page.waitForFunction(()=>window.lensLab?.sceneDebug()?.ready);assert.deepEqual((await project()).config,saved.config);assert.equal(await guide(),null);
    for(const raw of['{bad JSON',JSON.stringify({...saved,schemaVersion:99})]){const before=await project(),error=await page.evaluate(raw=>{try{window.lensLab.loadProject(raw);return'';}catch(error){return error.message;}},raw);assert.match(error,/원본/);assert.deepEqual(await project(),before);}
  });
  await check('real carriage drags and cancellation preserve camera and restore orbit controls',async()=>{
    await load(createProject({config:DEFAULT_CONFIG}));await page.locator('[data-camera="iso"]').click();await paint();const camera=(await debug()).camera;
    for(const kind of['target','screen']){await page.locator('#scene').scrollIntoViewIfNeeded();const rect=await page.locator('#scene').boundingBox(),handle=(await debug()).dragHandles.find(item=>item.kind===kind),before=(await current()).config;
      await page.mouse.move(rect.x+handle.x,rect.y+handle.y);await page.mouse.down();assert.equal((await debug()).dragging,kind);assert.equal((await debug()).orbitEnabled,false);await page.mouse.move(rect.x+handle.x+32,rect.y+handle.y,{steps:5});await paint();await page.mouse.up();await paint();assert.notEqual((await current()).config[kind==='target'?'objectDistanceMm':'screenDistanceMm'],before[kind==='target'?'objectDistanceMm':'screenDistanceMm']);assert.equal((await debug()).orbitEnabled,true);assert.equal((await debug()).dragging,null);assert.deepEqual((await debug()).camera,camera);await sceneParity();}
    const rect=await page.locator('#scene').boundingBox(),handle=(await debug()).dragHandles[0];await page.mouse.move(rect.x+handle.x,rect.y+handle.y);await page.mouse.down();assert.equal((await debug()).dragging,'target');await page.locator('#scene canvas').dispatchEvent('pointercancel',{pointerId:1,pointerType:'mouse',isPrimary:true,bubbles:true});await page.mouse.up();assert.equal((await debug()).orbitEnabled,true);assert.equal((await debug()).dragging,null);
  });
  await check('automatic saves without a camera fit their restored physical distances',async()=>{
    const isolated=await browser.newContext({viewport:{width:1600,height:1100}}),other=await isolated.newPage();watch(other);const saved=createProject({config:{...DEFAULT_CONFIG,objectDistanceMm:900,screenDistanceMm:900}});
    await other.addInitScript(raw=>{if(location.hostname==='127.0.0.1')localStorage.setItem('lens-lab-project-v1',raw);},serializeProject(saved));await other.goto('http://127.0.0.1:5221/');await other.waitForFunction(()=>window.lensLab?.sceneDebug()?.ready);await other.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const restored=await other.evaluate(()=>window.lensLab.sceneDebug().camera);await other.locator('[data-camera="iso"]').click();assert.deepEqual(await other.evaluate(()=>window.lensLab.sceneDebug().camera),restored);await isolated.close();
  });
  await check('future automatic-save data remains byte-for-byte protected and exportable',async()=>{
    const isolated=await browser.newContext({viewport:{width:1200,height:900},acceptDownloads:true}),other=await isolated.newPage();watch(other);const raw='\ufeff{"type":"lens-lab-project","schemaVersion":99,"untouched":"한글 원문"}';
    await other.addInitScript(raw=>{if(location.hostname==='127.0.0.1')localStorage.setItem('lens-lab-project-v1',raw);},raw);await other.goto('http://127.0.0.1:5221/');await other.waitForFunction(()=>window.lensLab?.project&&!document.querySelector('#storage-recovery').hidden);
    await other.locator('#screen-distance').fill('420');await other.locator('#screen-distance').press('Tab');assert.equal(await other.evaluate(()=>localStorage.getItem('lens-lab-project-v1')),raw);
    const pending=other.waitForEvent('download');await other.locator('#recover-original').click();const download=await pending,file=path.join(output,'protected-original.txt');await download.saveAs(file);assert.equal(await fs.readFile(file,'utf8'),raw);await isolated.close();
  });
  await check('desktop and narrow layouts expose controls and projection without horizontal overflow',async()=>{
    await page.locator('#new-project').click();await page.getByRole('button',{name:'알림 닫기'}).click();
    for(const width of[1600,1024,390]){await page.setViewportSize({width,height:width===390?844:1050});await page.locator('#reset-camera').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1,`overflow at ${width}`);for(const id of['object-distance','screen-distance','aperture','screen-preview','save-project','part-select'])assert.equal(await page.locator(`#${id}`).isVisible(),true);await page.screenshot({path:path.join(output,`lens-${width}.png`),fullPage:true});}
    await page.locator('#part-select').selectOption('screen-surface');await page.locator('#focus-part').click();await page.waitForFunction(()=>{const rect=document.querySelector('#scene').getBoundingClientRect();return rect.top>=-1&&rect.bottom<=innerHeight+1;});
    await page.setViewportSize({width:1600,height:1100});for(const view of['iso','side','screen']){await page.locator(`[data-camera="${view}"]`).click();await page.locator('#scene').screenshot({path:path.join(output,`scene-${view}.png`)});}
  });
  await check('smaller windows retain a live fixed-exposure projection beside the active distance and aperture controls',async()=>{
    for(const width of[1024,390]){await page.setViewportSize({width,height:768});for(const[id,value]of[['object-distance',330],['screen-distance',340],['aperture',9]]){await input(id,value);await paint();const preview=await page.locator('#control-preview').boundingBox(),inputBox=await page.locator(`#${id}`).boundingBox();assert.ok(preview.y>=0&&preview.y+preview.height<=768,`live preview outside ${width}px viewport for ${id}`);assert.ok(inputBox.y>=0&&inputBox.y+inputBox.height<=768);const bytes=await page.locator('#control-preview').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data));assert.deepEqual(bytes,await canvasPixels());}await page.screenshot({path:path.join(output,`live-controls-${width}.png`)});await page.locator('#show-observation').click();await page.waitForFunction(()=>{const rect=document.querySelector('.observation').getBoundingClientRect();return rect.top>=-1&&rect.top<200;});}
  });
  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
}catch(error){failure=error;console.error(error.stack);await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({message:error.message,stack:error.stack,checks,errors,externalRequests},null,2));}
finally{await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'FAILED':'PASSED',checks,gpu,errors,externalRequests},null,2));await context.close();await browser.close();await server.close();}
if(failure)process.exitCode=1;
