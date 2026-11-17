'use strict';
// Golden results from the preserved Pilot algorithm, independently checked by Java tests.
const fs=require('node:fs'),path=require('node:path');
const {createSampleOcr}=require('../../tests/mock/mock-textsense.server');
const pilot=require('../../src/features/ocr-result/ocr-result.extractor');
const rect={x:0,y:0,w:1,h:1};
const template={id:'form_parity',name:'청구서',docType:'청구서',version:1,keywords:['청구서'],keys:[
  {name:'문서번호',page:1,rect:{x:.15,y:.13,w:.2,h:.05},required:true,verify:true,pattern:'^A-\\d{4}-\\d{3}$'},
  {name:'합계금액',page:1,rect:{x:.15,y:.2,w:.2,h:.05},required:true,min:0,max:5000000},
]};
const cases=[];
function add(name,raw,t=template,sizes=[],engineFields=true){const normalized=pilot.normalizeOcr(raw,{pageSizes:sizes});cases.push({name,raw,template:t,sizes,engineFields,normalized,extracted:pilot.extractByTemplate(t,normalized,{useEngineFields:engineFields})});}
add('청구서 기본 영역과 숫자 검증',createSampleOcr());
add('원본 페이지 크기',createSampleOcr(),template,[{width:1000,height:1400,source:'image'}]);
for(const mode of ['word','line','cell'])add(mode,createSampleOcr(),{...template,keys:[{name:mode,page:1,mode,rect,...(mode==='cell'?{row:1,column:1}:{})}]});
for(const type of ['FindWord','FindLine','FindRow','FindRightRow','FindCol','FindBottomCol','FindRegion'])add(type,createSampleOcr(),{...template,keys:[{name:type,page:1,rect,searchType:type,searchKey:type==='FindWord'||type==='FindLine'?'문서번호':'품목'}]},[],false);
add('반복 표·Sub 키',createSampleOcr(),{...template,groups:[{name:'품목',page:1,rect,source:'table',skipRows:1,columns:[{name:'이름',column:0,rect},{name:'금액',column:1,rect,min:0}]}]});
add('반복 줄',createSampleOcr(),{...template,groups:[{name:'줄',page:1,rect,source:'lines',columns:[{name:'본문',rect}]}]});
const raw=createSampleOcr(),word={type:'word',points:[[10,20],[30,40]],recognition:{content:'엔진 값',confidence:[.9,.8]}};
raw.document.pages.pages_1.fields={actual:{keys:[],values:[word]},legacy:[word]};
add('SearchAPI 객체·배열',raw,{...template,keys:[{name:'actual',rect,searchType:'FindRegion'}]});
add('캐시 필드 배제 후 영역 재추출',raw,{...template,keys:[{name:'actual',rect,searchType:'FindRegion'}]},[],false);
add('필수값·검증 실패',createSampleOcr(),{...template,keys:[{name:'누락',rect:{x:.8,y:.5,w:.1,h:.1},required:true,verify:true}]});
const dest=path.resolve(__dirname,'../was/src/test/resources/pilot-parity.json');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,JSON.stringify(cases,null,2)+'\n');console.log(`Pilot parity fixtures: ${cases.length}`);
