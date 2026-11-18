'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {PDFDocument}=require('pdf-lib');
const ExcelJS=require('exceljs');
const sharp=require('sharp');
const {createSampleOcr}=require('../../tests/mock/mock-textsense.server');
const {uploadViaFtp}=require('../../tests/mock/ftp-upload.client');
const origin=process.env.PRODUCT_TEST_ORIGIN,token=process.env.FORMREADER_SETUP_TOKEN;
const gatewayPort=Number(process.env.PRODUCT_TEST_GATEWAY_PORT||18377);
const artifacts=process.env.PRODUCT_TEST_ARTIFACTS;
const password='Product-flow-password-2026';

test('Java product: OCR, review, all exports and workspace features',{skip:!origin||!token},async t=>{
  let cookie='',failBuild=false,skipOutput=false,delay=40,blank=false,templateBoundary=false,dropStatus=0;
  const tasks=new Map(),requests=[],timers=new Set();
  const later=(fn,ms)=>{const timer=setTimeout(async()=>{timers.delete(timer);try{await fn();}catch{}},ms);timers.add(timer);};
  const gateway=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.url==='/textsense/api/job/build'){
      requests.push(body);if(failBuild)return reply(503,{error:'fixture unavailable'});
      const id=crypto.randomUUID(),task={status:'AWAITING',errors:[]};tasks.set(id,task);reply(200,{id,status:task.status});
      const mode={blank,templateBoundary,skipOutput,delay};
      later(async()=>{task.status='PROGRESSING';try{
        const input=await fetch(body.inputUri);if(!input.ok)throw new Error('input HTTP '+input.status);const bytes=Buffer.from(await input.arrayBuffer());
        let count=1,title='';try{const pdf=await PDFDocument.load(bytes);count=pdf.getPageCount();title=pdf.getTitle()||'';}catch{const m=await sharp(bytes).metadata();count=m.pages||1;}
        const pages={};let selection=Array.from({length:count},(_,i)=>i+1);const pageOption=body.extraJobs[0].option.pages;
        if(pageOption!=='all')selection=pageOption.split(',').flatMap(range=>{const[a,b]=range.split('-').map(Number);return b===undefined?[a]:Array.from({length:b-a+1},(_,i)=>a+i);});
        selection.forEach((n,i)=>{const sample=structuredClone(createSampleOcr().document.pages.pages_1);sample.width=1000;sample.height=1400;
          if(title==='changed') {sample.content=sample.content.replaceAll('A-2025-001','A-2025-002');const change=el=>{if(el.recognition?.content==='A-2025-001')el.recognition.content='A-2025-002';(el.texts||el.cells||[]).forEach(change);};sample.elements.forEach(change);}
          if(mode.blank&&n===2){sample.content='';sample.elements=[];}
          if(mode.templateBoundary&&n===count) { sample.content=sample.content.replaceAll('청구서','영수증');const change=el=>{if(el.recognition?.content==='청구서')el.recognition.content='영수증';(el.texts||el.cells||[]).forEach(change);};sample.elements.forEach(change); }
          if(title==='layout') { const move=el=>{if(el.points)el.points=el.points.map(([x,y])=>[x+50,y+50]);(el.texts||el.cells||[]).forEach(move);};sample.elements.forEach(move); }
          for(const rule of body.extraJobs[0].option.reqOption.SearchAPI||[])sample.fields[rule.Name]={keys:[],values:[{type:'word',recognition:{content:'엔진 캐시',confidence:.95}}]};
          pages['pages_'+(i+1)]=sample;
        });
        later(async()=>{try{if(!mode.skipOutput)await uploadViaFtp(body.outputUri,Buffer.from(JSON.stringify({document:{version:'2.0.0',pages}})));task.status='SUCCESS';}catch(e){task.status='FAILURE';task.errors=[{code:'MOCK_FTP',message:e.message}];}},mode.delay);
      }catch(e){task.status='FAILURE';task.errors=[{code:'MOCK_INPUT',message:e.message}];}},10);
    }else if(req.url==='/textsense/api/job/status'){
      if(dropStatus>0){dropStatus--;return req.socket.destroy();}const task=tasks.get(body.id);reply(task?200:404,task?{status:task.status}:{});
    }else if(req.url.startsWith('/textsense/api/job/errors')){const id=new URL(req.url,'http://fixture').searchParams.get('id');reply(200,{errors:tasks.get(id)?.errors||[]});}
    else reply(404,{});
  });
  await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(gatewayPort,'127.0.0.1',resolve);});
  t.after(async()=>{for(const timer of timers)clearTimeout(timer);gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));});
  async function request(method,url,body,session=cookie){const response=await fetch(new URL(url,origin),{method,redirect:'manual',headers:{Origin:origin,'X-Requested-With':'TextSense',Cookie:session,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(url==='/api/account/setup'?{'X-Setup-Token':token}:{})},body:body!==undefined?JSON.stringify(body):undefined});const bytes=Buffer.from(await response.arrayBuffer());let json;try{json=JSON.parse(bytes);}catch{}return{status:response.status,bytes,json,headers:response.headers,cookie:response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};}
  async function ok(method,url,body){const r=await request(method,url,body);assert.equal(r.status,200,JSON.stringify(r.json));return r.json.data;}
  async function pdf(count=2,title=''){const doc=await PDFDocument.create();doc.setTitle(title);for(let i=0;i<count;i++)doc.addPage([500,700]);return Buffer.from(await doc.save()).toString('base64');}
  async function wait(id){for(let i=0;i<600;i++){const job=await ok('GET','/api/jobs/'+id);if(!['pending','processing'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Job did not finish');}
  async function job(extra={}){const created=await ok('POST','/api/jobs',{fileName:'제품 검증.pdf',contentBase64:await pdf(),...extra});const result=await wait(created.id);assert.equal(result.status,'done',JSON.stringify(result));return result;}
  const status=await ok('GET','/api/account/status');
  if(status.needsSetup)await ok('POST','/api/account/setup',{name:'흐름 관리자',email:'flow-admin@product.example.test',password});
  let signed=await request('POST','/api/auth/sign-in/email',{email:'flow-admin@product.example.test',password});assert.equal(signed.status,200,JSON.stringify(signed.json));cookie=signed.cookie;
  const rect={x:0,y:0,w:1,h:1};let form,first;
  await t.test('existing UI APIs, health and signed input access',async()=>{
    assert.equal((await ok('GET','/api/account/me')).capabilities.ocrProcessing,true);
    assert.equal((await request('GET','/api/jobs',undefined,'')).status,401);
    assert.equal((await request('GET','/files/input/job_unknown.pdf?token=invalid')).status,403);
    assert.equal((await ok('GET','/api/ocr/connection')).mode,'mock');
    assert.equal((await request('POST','/api/jobs',{fileName:'bad.pdf',contentBase64:'broken'})).status,400);
  });
  await t.test('PDF upload → signed HTTP fetch → actual FTP upload → extraction and table/Sub keys',async()=>{
    form=await ok('POST','/api/forms',{name:'청구서',docType:'청구',keywords:['청구서'],keys:[{name:'문서번호',page:1,mode:'word',wordIndex:0,rect:{x:.15,y:.13,w:.2,h:.05},required:true,verify:true,pattern:'^A-\\d{4}-\\d{3}$'}],groups:[{name:'품목',page:1,rect,source:'table',skipRows:1,columns:[{name:'이름',column:0},{name:'금액',column:1,required:true,min:0}]}]});
    dropStatus=2;first=await job({templateId:form.id});assert.equal(first.ocrResult.values.문서번호.value,'A-2025-001');assert.equal(first.ocrResult.groups.품목.rows[0].values.금액.value,'1,234,000');assert.equal(first.ocrResult.pageCount,2);
    assert.match(requests.at(-1).inputUri,/\/files\/input\/.*\?token=/);assert.match(requests.at(-1).outputUri,/^ftp:/);
    const view=await ok('GET',`/api/jobs/${first.id}/ocr`);assert.equal(view.pages[0].tables[0].grid[1][1],'1,234,000');
    const source=await request('GET',`/api/jobs/${first.id}/file`);assert.equal(source.status,200);assert.equal((await PDFDocument.load(source.bytes)).getPageCount(),2);
    assert.equal((await ok('GET','/api/jobs')).find(j=>j.id===first.id).result.classified,true);
  });
  await t.test('review validation, drafts, confirmation, repeat rows and original OCR preservation',async()=>{
    const original=(await ok('GET',`/api/jobs/${first.id}/ocr`)).pages;
    const groups={品:[]};
    assert.equal((await request('PUT',`/api/jobs/${first.id}/review`,{values:{문서번호:'invalid'},confirmed:true})).status,400);
    const draft=await ok('PUT',`/api/jobs/${first.id}/review`,{values:{문서번호:'invalid'},confirmed:false});assert.equal(draft.review.values.문서번호.valid,false);
    const reviewed=await ok('PUT',`/api/jobs/${first.id}/review`,{values:{문서번호:'A-2026-777'},groups:{품목:[{이름:'검수 서비스',금액:'2,000,000'}]},text:'검수한 본문 <&> 한글',confirmed:true});
    assert.equal(reviewed.review.confirmed,true);assert.equal(reviewed.review.groups.품목.rows[0].values.금액.value,'2,000,000');assert.equal(reviewed.ocrResult.values.문서번호.value,'A-2025-001');assert.deepEqual((await ok('GET',`/api/jobs/${first.id}/ocr`)).pages,original);
    assert.equal((await request('PUT',`/api/jobs/${first.id}/review`,{values:{unknown:'x'}})).status,400);
  });
  await t.test('all seven export files contain reviewed values and valid binary formats',async()=>{
    for(const format of ['json','xml','txt','csv','xlsx','pdf','md']){
      const r=await request('GET',`/api/jobs/${first.id}/export?format=${format}`);assert.equal(r.status,200,JSON.stringify(r.json));assert.ok(r.bytes.length>0);assert.match(r.headers.get('content-disposition'),/attachment/);
      if(artifacts){fs.mkdirSync(artifacts,{recursive:true});fs.writeFileSync(path.join(artifacts,'result.'+format),r.bytes);}
      if(format==='json'){assert.equal(r.json.values.문서번호.value,'A-2026-777');assert.equal(r.json.groups.품목.rows[0].values.금액.value,'2,000,000');}
      if(format==='txt')assert.equal(r.bytes.toString(),'검수한 본문 <&> 한글');
      if(format==='xml')assert.match(r.bytes.toString(),/&lt;&amp;&gt;/);
      if(format==='csv'||format==='md')assert.match(r.bytes.toString(),/A-2026-777/);
      if(format==='xlsx'){const book=new ExcelJS.Workbook();await book.xlsx.load(r.bytes);assert.equal(book.getWorksheet('추출 항목').getCell('B2').value,'A-2026-777');assert.equal(book.getWorksheet('본문').getCell('B2').value,'검수한 본문 <&> 한글');assert.equal(book.getWorksheet('표_1_1').getCell('B2').value,'1,234,000');}
      if(format==='pdf'){const doc=await PDFDocument.load(r.bytes);assert.equal(doc.getPageCount(),2);assert.match(r.bytes.subarray(0,8).toString(),/^%PDF/);}
    }
    assert.equal((await request('GET',`/api/jobs/${first.id}/export?format=exe`)).status,400);
  });
  await t.test('sample PDF/TIFF preview and OCR using an unsaved template',async()=>{
    const sample=await ok('POST','/api/samples',{fileName:'샘플.pdf',contentBase64:await pdf()});assert.equal(sample.pageSizes.length,2);assert.equal((await request('GET',`/api/samples/${sample.id}/image?page=1`)).headers.get('content-type'),'image/png');
    const preview=await ok('POST','/api/samples/preview',{sampleId:sample.id,template:form});assert.equal((await wait(preview.id)).status,'done');
    const tiff=await sharp({create:{width:100,height:100,channels:3,background:'white'}}).tiff().toBuffer();const image=await job({fileName:'문서.tiff',contentBase64:tiff.toString('base64')});assert.equal((await request('GET',`/api/jobs/${image.id}/image?page=1`)).headers.get('content-type'),'image/png');
  });
  await t.test('manual/automatic split and actual child PDF pages',async()=>{
    const children=await ok('POST',`/api/jobs/${first.id}/split`,{groups:[[1],[2]]});assert.equal(children.length,2);for(const c of children){assert.equal(c.relation,'split');assert.equal((await PDFDocument.load((await request('GET',`/api/jobs/${c.id}/file`)).bytes)).getPageCount(),1);}
    assert.equal((await request('POST',`/api/jobs/${first.id}/split`,{groups:[[1],[1]]})).status,400);
    const automatic=await job({split:{mode:'pages',count:1}});for(let i=0;i<100;i++){const j=await ok('GET','/api/jobs/'+automatic.id);if(j.children){assert.equal(j.children.length,2);break;}await new Promise(r=>setTimeout(r,20));if(i===99)throw new Error('Automatic split missing');}
    blank=true;const blankJob=await job({contentBase64:await pdf(3),split:{mode:'blank'}});blank=false;for(let i=0;i<100;i++){const j=await ok('GET','/api/jobs/'+blankJob.id);if(j.children){assert.equal(j.children.length,2);break;}await new Promise(r=>setTimeout(r,20));if(i===99)throw new Error('Blank-page split missing');}
    await ok('POST','/api/forms',{name:'영수증 분리',docType:'영수증',keywords:['영수증'],keys:[{name:'본문',rect}]});templateBoundary=true;const boundary=await job({contentBase64:await pdf(3),split:{mode:'template'}});templateBoundary=false;for(let i=0;i<100;i++){const j=await ok('GET','/api/jobs/'+boundary.id);if(j.children){assert.equal(j.children.length,2);break;}await new Promise(r=>setTimeout(r,20));if(i===99)throw new Error('Template-boundary split missing');}
  });
  await t.test('policy merge, auto-classification second pass, reapply without stale engine fields, selected pages',async()=>{
    await ok('PUT','/api/workspace/settings',{engine:{reqType:'Document',reqOption:{CustomSetting:{TextScoreThreshold:.5,TextInputMaxAxis:2200}}}});
    const search=await ok('POST','/api/forms',{...form,id:undefined,name:'SearchAPI 서식',keywords:['청구서'],keys:[{name:'문서번호',rect,searchType:'FindLine',searchKey:'문서번호'}],groups:[],engineRequest:{reqOption:{CustomSetting:{TextScoreThreshold:.7}}}});
    const recognized=await job({templateId:search.id});assert.equal(recognized.ocrResult.values.문서번호.value,'엔진 캐시');assert.equal(requests.at(-1).extraJobs[0].option.reqOption.CustomSetting.TextInputMaxAxis,2200);
    const reapplied=await ok('POST',`/api/jobs/${recognized.id}/reapply`,{templateId:search.id});assert.match(reapplied.ocrResult.values.문서번호.value,/A-2025-001/);assert.equal(reapplied.review,null);
    const partial=await job({templateId:search.id,options:{pages:'2'}});assert.deepEqual((await ok('GET',`/api/jobs/${partial.id}/ocr`)).pages.map(p=>p.page),[2]);
    assert.equal((await request('POST','/api/jobs',{fileName:'bad.pdf',contentBase64:await pdf(),options:{pages:'99'}})).status,400);
    await ok('PUT',`/api/forms/${form.id}`,{...form,keywords:['no-auto-match']});const before=requests.length;await job();assert.equal(requests.length-before,2,'classified SearchAPI policy needs a second engine pass');
    await ok('PUT','/api/workspace/settings',{engine:{reqType:'Document',reqOption:{SearchAPI:[{Type:'FindLine',Name:'文書',Key:['x']}]}}});
    const duplicate=await request('POST','/api/jobs',{fileName:'bad.pdf',contentBase64:await pdf(),templateSnapshot:{...form,keys:[{name:'文書',rect,searchType:'FindLine',searchKey:'x'}]}});assert.equal(duplicate.status,400);
    await ok('PUT','/api/workspace/settings',{engine:{reqType:'Document',reqOption:{}}});
  });
  await t.test('connection failures, retained-source retry, cancellation and diagnostics',async()=>{
    failBuild=true;const failed=await wait((await ok('POST','/api/jobs',{fileName:'재시도.pdf',contentBase64:await pdf()})).id);assert.equal(failed.status,'failed');assert.equal((await ok('GET',`/api/jobs/${failed.id}/diagnostics`)).sourcePresent,true);failBuild=false;const retried=await ok('POST',`/api/jobs/${failed.id}/retry`,{});assert.equal((await wait(retried.id)).status,'done');assert.equal(retried.parentId,failed.id);
    delay=1500;const pending=await ok('POST','/api/jobs',{fileName:'취소.pdf',contentBase64:await pdf()});const cancelled=await ok('POST',`/api/jobs/${pending.id}/cancel`,{});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.cancellation.engineStopped,false);delay=40;await new Promise(r=>setTimeout(r,80));assert.equal((await ok('GET','/api/jobs/'+pending.id)).status,'cancelled');
    skipOutput=true;const absent=await wait((await ok('POST','/api/jobs',{fileName:'수신 실패.pdf',contentBase64:await pdf(),templateId:form.id})).id);skipOutput=false;assert.equal(absent.status,'failed');assert.equal(absent.errorCode,'TIMEOUT');
  });
  await t.test('text/layout comparisons and persisted history',async()=>{
    const changed=await job({contentBase64:await pdf(2,'changed')});const comparison=await ok('POST','/api/comparisons',{leftId:first.id,rightId:changed.id,compareLayout:true});assert.ok(comparison.differences.some(d=>d.type==='changed'));assert.ok(comparison.differences.some(d=>d.leftWords?.length&&d.rightWords?.length));assert.equal((await ok('GET','/api/comparisons/'+comparison.id)).id,comparison.id);assert.ok((await ok('GET','/api/comparisons')).some(c=>c.id===comparison.id&&c.differenceCount>0));
    const shifted=await job({contentBase64:await pdf(2,'layout')});assert.ok((await ok('POST','/api/comparisons',{leftId:first.id,rightId:shifted.id,compareLayout:true})).differences.some(d=>d.type==='moved'));
    const shorter=await job({contentBase64:await pdf(1)});assert.ok((await ok('POST','/api/comparisons',{leftId:first.id,rightId:shorter.id})).differences.some(d=>d.type==='pages'));
  });
  await t.test('business delivery retries and idempotency, operations monitor and reset authorization',async()=>{
    let deliveries=0,received;const receiver=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);received={headers:req.headers,payload:JSON.parse(Buffer.concat(chunks))};deliveries++;res.writeHead(deliveries===1?503:200);res.end('{}');});await new Promise(r=>receiver.listen(0,'127.0.0.1',r));
    try{await ok('PUT','/api/workspace/settings',{integration:{url:`http://127.0.0.1:${receiver.address().port}/result`,token:'fixture-bearer-token',autoSend:false}});const sent=await ok('POST',`/api/jobs/${first.id}/deliver`,{});assert.equal(sent.status,'sent');assert.equal(sent.attempts,2);assert.equal(received.payload.values.문서번호.value,'A-2026-777');assert.equal(received.headers.authorization,'Bearer fixture-bearer-token');await ok('POST',`/api/jobs/${first.id}/deliver`,{});assert.equal(deliveries,2);assert.equal((await ok('GET','/api/workspace/settings')).integration.token,undefined);const monitor=await ok('GET','/api/workspace/monitor');assert.ok(monitor.jobs.total>0);assert.ok(monitor.events.length>0);assert.ok(monitor.local.storage.total>0);assert.equal((await request('POST','/api/workspace/reset',{confirm:'wrong'})).status,400);
      const target=`http://127.0.0.1:${receiver.address().port}/result`;await ok('PUT','/api/workspace/settings',{integration:{url:target,autoSend:true}});const automatic=await job({templateId:form.id});for(let i=0;i<200;i++){const m=await ok('GET','/api/workspace/monitor');if(m.deliveries.some(d=>d.jobId===automatic.id&&d.status==='sent'))break;await new Promise(r=>setTimeout(r,20));if(i===199)throw new Error('Automatic delivery missing');}assert.equal(deliveries,3);await ok('PUT','/api/workspace/settings',{integration:{url:target,autoSend:false}});
    }finally{receiver.closeAllConnections();await new Promise(r=>receiver.close(r));}
    const email=`flow-user-${Date.now()}@product.example.test`;const signup=await request('POST','/api/auth/sign-up/email',{name:'일반 사용자',email,password,role:'admin'});assert.equal(signup.status,200);const uid=signup.json.data.user.id;await ok('PUT','/api/users/'+uid,{role:'user',status:'active'});const login=await request('POST','/api/auth/sign-in/email',{email,password});assert.equal(login.status,200);assert.equal((await request('GET','/api/workspace/monitor',undefined,login.cookie)).status,403);assert.equal((await request('POST','/api/workspace/reset',{confirm:'문서 초기화'},login.cookie)).status,403);assert.equal((await request('GET','/api/jobs',undefined,login.cookie)).status,200);
  });
  await t.test('reset clears documents and optional templates while preserving accounts and settings',async()=>{
    await new Promise(r=>setTimeout(r,1600));const reset=await ok('POST','/api/workspace/reset',{confirm:'문서 초기화',includeTemplates:false});assert.ok(reset.removedJobs>0);assert.equal(reset.accountsPreserved,true);assert.equal((await ok('GET','/api/jobs')).length,0);assert.ok((await ok('GET','/api/forms')).length>0);assert.equal((await ok('GET','/api/account/me')).user.role,'admin');await ok('POST','/api/workspace/reset',{confirm:'문서 초기화',includeTemplates:true});assert.equal((await ok('GET','/api/forms')).length,0);
  });
});
