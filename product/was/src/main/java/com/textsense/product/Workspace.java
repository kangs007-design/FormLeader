package com.textsense.product;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import com.github.difflib.DiffUtils;
import com.github.difflib.algorithm.DiffAlgorithmListener;
import com.github.difflib.patch.*;
import java.lang.management.ManagementFactory;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.io.InputStream;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.stream.Collectors;
import static com.textsense.product.Nodes.*;

final class Workspace {
    final Database db;
    final Jobs jobs;
    final Exports exports;
    final AuthService auth;
    final Records settings,samples,comparisons,deliveries;
    final ConcurrentHashMap<String,CompletableFuture<ObjectNode>> outgoing=new ConcurrentHashMap<>();
    Workspace(Database db,Jobs jobs,Exports exports,AuthService auth) throws Exception {
        this.db=db;this.jobs=jobs;this.exports=exports;this.auth=auth;settings=jobs.settings;samples=new Records(db,"form-samples");comparisons=new Records(db,"document-comparisons");deliveries=new Records(db,"deliveries");
        for(JsonNode d:deliveries.list()) if(Set.of("pending","sending").contains(d.path("status").asText())) deliveries.patch(d.path("id").asText(),obj("status","failed","error","서버 재시작으로 전송 완료를 확인하지 못했습니다. 같은 전송 키로 다시 시도하세요."));
    }
    ObjectNode settings() throws Exception {
        ObjectNode engine=settings.find("engine"),integration=settings.find("integration");
        return obj("engine",engine==null?obj("reqType","Document","reqOption",obj()):engine.path("policy"),"integration",obj("url",integration==null?"":integration.path("url").asText(),"monitorUrl",integration==null?"":integration.path("monitorUrl").asText(),"tokenConfigured",integration!=null&&!integration.path("token").asText().isEmpty(),"autoSend",integration!=null&&integration.path("autoSend").asBoolean()),"capabilities",obj("requestPolicy",true,"persistentEnginePolicy",true,"cancelConfigured",!jobs.config.cancelPath.isEmpty(),"pdfOcrScale",jobs.config.pdfScale));
    }
    static String url(String text) {
        if(text.isEmpty()) return "";try { URI u=URI.create(text);if(!Set.of("http","https").contains(u.getScheme())||u.getHost()==null||u.getUserInfo()!=null||u.getFragment()!=null) throw new IllegalArgumentException();return u.toString(); }catch(Exception e) { throw ApiError.bad("인증 정보를 제외한 HTTP/HTTPS 주소를 입력하세요."); }
    }
    ObjectNode saveSettings(ObjectNode input) throws Exception {
        if(input.has("engine")) { ObjectNode engine=object(input.get("engine"));if(!engine.path("reqOption").isObject()||engine.toString().length()>100000||!engine.path("reqType").asText("Document").equals("Document")) throw ApiError.bad("엔진 정책은 Document 유형과 reqOption 객체를 포함해야 합니다.");Templates.validateOptions(engine.path("reqOption"));settings.put(obj("id","engine","policy",engine,"updatedAt",now())); }
        if(input.has("integration")) { ObjectNode i=object(input.get("integration")),previous=settings.find("integration");String token=i.has("token")?Json.string(i,"token"):previous==null?"":previous.path("token").asText(),target=url(Json.string(i,"url")),monitor=url(Json.string(i,"monitorUrl"));if(token.length()>5000||token.contains("\r")||token.contains("\n")) throw ApiError.bad("인증 토큰을 확인하세요.");if(i.path("autoSend").asBoolean()&&target.isEmpty()) throw ApiError.bad("자동 전송에 수신 URL이 필요합니다.");settings.put(obj("id","integration","url",target,"monitorUrl",monitor,"token",token,"autoSend",i.path("autoSend").asBoolean())); }
        return settings();
    }
    ObjectNode sample(ObjectNode input) throws Exception {
        jobs.lifecycle.readLock().lock();try { if(jobs.resetting) throw ApiError.bad("문서 초기화 중입니다.");String name=Documents.name(Json.string(input,"fileName")),ext=Documents.extension(name);if(!Documents.EXTENSIONS.contains(ext)) throw ApiError.bad("PDF·이미지 샘플을 선택하세요.");String id=id("sample"),stored=id+"."+ext;Path file=Documents.managed(jobs.config.input,stored);Documents.atomic(file,Documents.decode(Json.string(input,"contentBase64")));try { return samples.insert(obj("id",id,"fileName",name,"storedName",stored,"pageSizes",Documents.geometry(file,jobs.config.pdfScale),"createdAt",now())); }catch(Exception e) { Files.deleteIfExists(file);throw ApiError.bad("샘플 문서를 읽을 수 없습니다."); } }finally { jobs.lifecycle.readLock().unlock(); }
    }
    ObjectNode preview(ObjectNode input,String actor) throws Exception { ObjectNode sample=samples.get(Json.string(input,"sampleId"));return jobs.create(obj("fileName",sample.path("fileName"),"contentBase64",Base64.getEncoder().encodeToString(Files.readAllBytes(Documents.managed(jobs.config.input,sample.path("storedName").asText()))),"templateSnapshot",input.path("template")),actor,true); }
    static List<JsonNode> tokens(JsonNode view) {
        List<JsonNode> result=new ArrayList<>();
        for(JsonNode p:items(view.path("pages"))) {
            List<JsonNode> words=items(p.path("words"));if(words.isEmpty()) { for(String word:p.path("content").asText().split("\\s+")) if(!word.isEmpty()) result.add(obj("text",word,"page",p.path("page"),"rect",null));continue; }
            List<JsonNode> normalized=new ArrayList<>();for(JsonNode w:words) normalized.add(((ObjectNode)w.deepCopy()).put("cx",w.path("x1").asDouble()/p.path("width").asDouble()).put("cy",w.path("y1").asDouble()/p.path("height").asDouble()).put("h",(w.path("y2").asDouble()-w.path("y1").asDouble())/p.path("height").asDouble()));
            for(List<JsonNode> line:Ocr.lines(normalized,0.6)) { line.sort(Comparator.comparingDouble(w->w.path("cx").asDouble()));for(JsonNode w:line) result.add(obj("text",w.path("text"),"page",p.path("page"),"rect",obj("x",w.path("x1").asDouble()/p.path("width").asDouble(),"y",w.path("y1").asDouble()/p.path("height").asDouble(),"w",(w.path("x2").asDouble()-w.path("x1").asDouble())/p.path("width").asDouble(),"h",(w.path("y2").asDouble()-w.path("y1").asDouble())/p.path("height").asDouble()))); }
        }
        return result;
    }
    static JsonNode anchor(List<JsonNode> values,int index) { return values.isEmpty()?null:values.get(Math.min(values.size()-1,Math.max(0,index))); }
    static void moved(ArrayNode out,List<JsonNode> a,List<JsonNode> b,int left,int right,int count,boolean compare) {
        if(!compare) return;for(int i=0;i<count;i++) { JsonNode x=a.get(left+i),y=b.get(right+i);boolean moved=x.path("page").asInt()!=y.path("page").asInt();if(x.path("rect").isObject()&&y.path("rect").isObject()) for(String k:List.of("x","y","w","h")) moved|=Math.abs(x.path("rect").path(k).asDouble()-y.path("rect").path(k).asDouble())>.02;if(moved) out.add(obj("type","moved","left",x,"right",y,"leftWords",arr(x),"rightWords",arr(y),"text",x.path("text"))); }
    }
    ObjectNode compare(ObjectNode input,String actor) throws Exception {
        String left=Json.string(input,"leftId"),right=Json.string(input,"rightId");if(left.isEmpty()||right.isEmpty()||left.equals(right)) throw ApiError.bad("서로 다른 두 문서를 선택하세요.");
        ObjectNode lv=jobs.view(left),rv=jobs.view(right);List<JsonNode>a=tokens(lv),b=tokens(rv);if(a.size()+b.size()>100000) throw ApiError.bad("비교할 문서가 너무 큽니다. 문서를 분리하세요.");
        boolean ignore=input.path("ignoreWhitespace").asBoolean(),layout=input.path("compareLayout").asBoolean();List<String> x=a.stream().map(w->ignore?w.path("text").asText().replaceAll("\\s",""):w.path("text").asText()).toList(),y=b.stream().map(w->ignore?w.path("text").asText().replaceAll("\\s",""):w.path("text").asText()).toList();long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        var patch=DiffUtils.diff(x,y,new DiffAlgorithmListener(){ public void diffStart(){} public void diffEnd(){} public void diffStep(int step,int total){if(System.nanoTime()>deadline||step>20000) throw ApiError.bad("비교량이 제한을 초과했습니다. 문서를 분리하세요.");} });
        ArrayNode differences=arr();if(lv.path("pages").size()!=rv.path("pages").size()) differences.add(obj("type","pages","left",obj("page",1,"rect",null),"right",obj("page",1,"rect",null),"text","페이지 수: "+lv.path("pages").size()+" → "+rv.path("pages").size()));
        int ai=0,bi=0;for(AbstractDelta<String> delta:patch.getDeltas()) { int ap=delta.getSource().getPosition(),bp=delta.getTarget().getPosition();moved(differences,a,b,ai,bi,Math.min(ap-ai,bp-bi),layout);int ac=delta.getSource().size(),bc=delta.getTarget().size();List<JsonNode> aw=a.subList(ap,ap+ac),bw=b.subList(bp,bp+bc);String old=aw.stream().map(w->w.path("text").asText()).collect(Collectors.joining(" ")),next=bw.stream().map(w->w.path("text").asText()).collect(Collectors.joining(" "));differences.add(obj("type",ac==0?"added":bc==0?"removed":"changed","left",anchor(a,ap),"right",anchor(b,bp),"leftWords",aw,"rightWords",bw,"text",ac==0?next:bc==0?old:old+" → "+next));ai=ap+ac;bi=bp+bc; }
        moved(differences,a,b,ai,bi,Math.min(a.size()-ai,b.size()-bi),layout);
        return comparisons.insert(obj("id",id("compare"),"leftId",left,"rightId",right,"differences",differences,"ignoreWhitespace",ignore,"compareLayout",layout,"createdAt",now(),"actor",actor));
    }
    ArrayNode comparisons() throws Exception { ArrayNode result=arr();for(JsonNode n:comparisons.list()) { ObjectNode c=n.deepCopy();c.put("differenceCount",c.path("differences").size());c.remove("differences");result.add(c); }return result; }
    void autoDeliver(String id) throws Exception { ObjectNode integration=settings.find("integration");if(!jobs.resetting&&integration!=null&&integration.path("autoSend").asBoolean()) deliver(id,"automatic"); }
    ObjectNode deliver(String id,String actor) throws Exception {
        if(jobs.resetting) throw ApiError.bad("문서 초기화 중입니다.");ObjectNode integration=settings.find("integration");if(integration==null||integration.path("url").asText().isEmpty()) throw ApiError.bad("업무 서버 수신 URL을 설정하세요.");
        ObjectNode d=exports.data(id),payload=obj("event","document.completed","jobId",id,"fileName",d.path("fileName"),"templateId",d.path("job").path("ocrResult").path("templateId"),"values",d.path("values"),"groups",d.path("groups"),"text",d.path("text"),"review",d.path("review"));String key=Passwords.sha256(integration.path("url").asText()+payload.toString());ObjectNode previous=deliveries.find(key);if(previous!=null&&previous.path("status").asText().equals("sent")) return previous;
        CompletableFuture<ObjectNode> mine=new CompletableFuture<>(),existing=outgoing.putIfAbsent(key,mine);if(existing!=null) return existing.get();
        try {
            ObjectNode record=deliveries.find(key);if(record==null) record=deliveries.insert(obj("id",key,"jobId",id,"url",integration.path("url"),"status","pending","attempts",0,"createdAt",now(),"actor",actor));int prior=record.path("attempts").asInt();
            for(int attempt=1;attempt<=3;attempt++) {
                deliveries.patch(key,obj("status","sending","attempts",prior+attempt,"updatedAt",now()));
                boolean retry=true;
                try { HttpRequest.Builder request=HttpRequest.newBuilder(URI.create(integration.path("url").asText())).timeout(Duration.ofSeconds(10)).header("Content-Type","application/json").header("Idempotency-Key",key).POST(HttpRequest.BodyPublishers.ofString(payload.toString()));if(!integration.path("token").asText().isEmpty()) request.header("Authorization","Bearer "+integration.path("token").asText());HttpResponse<InputStream> response=jobs.client.http.send(request.build(),HttpResponse.BodyHandlers.ofInputStream());try(InputStream body=response.body()) { int status=response.statusCode();if(status>=200&&status<300) { ObjectNode sent=deliveries.patch(key,obj("status","sent","httpStatus",status,"error",null,"updatedAt",now()));mine.complete(sent);return sent; }retry=status>=500||status==429;throw new java.io.IOException("HTTP "+status); } }
                catch(Exception e) { if(!retry||attempt==3) { ObjectNode failed=deliveries.patch(key,obj("status","failed","error",TextSense.redact(e.getMessage()),"updatedAt",now()));mine.complete(failed);return failed; } }
                Thread.sleep(attempt*500L);
            }
            throw new IllegalStateException("No delivery result");
        }catch(Exception e) { mine.completeExceptionally(e);throw e; }finally { outgoing.remove(key,mine); }
    }
    ObjectNode monitor() throws Exception {
        var bean=ManagementFactory.getOperatingSystemMXBean();long total=Runtime.getRuntime().totalMemory(),free=Runtime.getRuntime().freeMemory();double cpu=0;
        if(bean instanceof com.sun.management.OperatingSystemMXBean os) { total=os.getTotalMemorySize();free=os.getFreeMemorySize();cpu=Math.max(0,os.getCpuLoad()*100); }
        var storage=Files.getFileStore(jobs.config.data);ArrayNode values=jobs.list(),events=arr(),failures=arr();int processing=0,failed=0,cancelled=0;Map<String,String> users=new HashMap<>();for(JsonNode user:auth.users()) users.put(user.path("id").asText(),user.path("name").asText());List<JsonNode> sortedEvents=new ArrayList<>();
        for(JsonNode job:values) { String status=job.path("status").asText();if(Set.of("pending","processing").contains(status)) processing++;if(status.equals("failed")) failed++;if(status.equals("cancelled")) cancelled++;for(JsonNode event:items(job.path("events"))) { ObjectNode e=event.deepCopy();e.setAll(obj("jobId",job.path("id"),"fileName",job.path("fileName"),"actorName",users.getOrDefault(event.path("actor").asText(),event.path("actor").asText().equals("automatic")?"자동 전송":"시스템")));sortedEvents.add(e); }
            for(String field:List.of("error","splitError","deliveryError")) if(job.hasNonNull(field)&&!job.path(field).asText().isEmpty()) { failures.add(obj("id",job.path("id"),"fileName",job.path("fileName"),"error",job.path(field),"code",job.get("errorCode"),"at",job.path("updatedAt")));break; }
        }
        sortedEvents.sort(Comparator.comparing((JsonNode n)->n.path("at").asText()).reversed());sortedEvents.stream().limit(500).forEach(events::add);ObjectNode remote=obj("configured",false),integration=settings.find("integration");
        if(integration!=null&&!integration.path("monitorUrl").asText().isEmpty()) { remote.put("configured",true);try { HttpRequest.Builder request=HttpRequest.newBuilder(URI.create(integration.path("monitorUrl").asText())).timeout(Duration.ofSeconds(4));if(!integration.path("token").asText().isEmpty()) request.header("Authorization","Bearer "+integration.path("token").asText());var response=jobs.client.http.send(request.build(),HttpResponse.BodyHandlers.ofInputStream());try(InputStream body=response.body()) { if(response.statusCode()!=200) throw new java.io.IOException("HTTP "+response.statusCode());byte[] bytes=body.readNBytes(1_048_577);if(bytes.length>1_048_576) throw new java.io.IOException("Response too large");remote.set("metrics",Json.MAPPER.readTree(bytes)); } }catch(Exception e) { remote.put("error",TextSense.redact(e.getMessage())); } }
        return obj("at",now(),"local",obj("host",InetAddress.getLocalHost().getHostName(),"cpuPercent",cpu,"memory",obj("total",total,"used",total-free),"storage",obj("total",storage.getTotalSpace(),"free",storage.getUsableSpace()),"processMemory",Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory(),"uptime",ManagementFactory.getRuntimeMXBean().getUptime()/1000.0),"services",obj("application","UP","gateway",jobs.client.tcp()),"remote",remote,"jobs",obj("total",values.size(),"processing",processing,"failed",failed,"cancelled",cancelled),"events",events,"failures",failures,"deliveries",deliveries.list());
    }
    ObjectNode reset(ObjectNode input,String actor) throws Exception {
        if(!Json.string(input,"confirm").equals("문서 초기화")) throw ApiError.bad("확인 문구 “문서 초기화”를 정확히 입력하세요.");
        jobs.lifecycle.writeLock().lock();try { if(jobs.resetting) throw ApiError.bad("이미 초기화 중입니다.");jobs.resetting=true; }finally { jobs.lifecycle.writeLock().unlock(); }
        try {
            for(JsonNode job:jobs.records.list()) if(Set.of("pending","processing").contains(job.path("status").asText())) try { jobs.cancel(job.path("id").asText(),actor); }catch(ApiError ignored) {}
            jobs.idle();for(CompletableFuture<ObjectNode> future:outgoing.values()) future.get();ArrayNode jobsBefore=jobs.records.list(),samplesBefore=samples.list();boolean templates=input.path("includeTemplates").asBoolean();
            db.transaction(c->{ for(String collection:templates?List.of("form-jobs","document-comparisons","deliveries","form-samples","form-templates","form-versions"):List.of("form-jobs","document-comparisons","deliveries")) Database.execute(c,"DELETE FROM fr_records WHERE collection=?",collection);return null; });
            for(JsonNode job:jobsBefore) { Files.deleteIfExists(jobs.source(job));Files.deleteIfExists(jobs.output(job.path("id").asText()));Files.deleteIfExists(Documents.managed(jobs.config.output,job.path("id").asText()+".classification.json")); }
            if(templates) for(JsonNode sample:samplesBefore) Files.deleteIfExists(Documents.managed(jobs.config.input,sample.path("storedName").asText()));
            return obj("removedJobs",jobsBefore.size(),"templatesRemoved",templates,"accountsPreserved",true);
        }finally { jobs.resetting=false; }
    }
}
