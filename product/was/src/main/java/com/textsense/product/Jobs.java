package com.textsense.product;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import static com.textsense.product.Nodes.*;

final class Jobs implements AutoCloseable {
    final Records records,settings;
    final RuntimeConfig config;
    final Templates forms;
    final TextSense client;
    final FtpReceiver ftp;
    final ReentrantReadWriteLock lifecycle=new ReentrantReadWriteLock();
    final Set<String> active=ConcurrentHashMap.newKeySet();
    final ThreadPoolExecutor workers;
    final byte[] signingSecret=Passwords.token().getBytes(StandardCharsets.UTF_8);
    volatile Workspace workspace;
    volatile boolean resetting;
    Jobs(Database db,Templates forms,RuntimeConfig config) throws Exception {
        this.config=config;this.forms=forms;records=new Records(db,"form-jobs");settings=new Records(db,"workspace-settings");client=new TextSense(config);ftp=new FtpReceiver(config);
        workers=new ThreadPoolExecutor(2,2,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(100),r->{Thread t=new Thread(r,"formreader-ocr");t.setDaemon(true);return t;});
        for(JsonNode job:items(records.list())) if(Set.of("pending","processing").contains(job.path("status").asText())) patch(job.path("id").asText(),obj("status","failed","errorCode","INTERRUPTED","error","서버 재시작으로 처리가 중단되었습니다. 보관된 원본으로 다시 처리하세요."),"status.failed",null);
    }
    ArrayNode list() throws Exception {
        ArrayNode result=arr();for(JsonNode value:records.list()) { ObjectNode item=value.deepCopy();JsonNode o=item.remove("ocrResult");ObjectNode summary=null;if(o!=null&&!o.isNull()) summary=obj("classified",o.path("classified"),"docType",o.path("docType"),"needsReview",o.path("needsReview"),"pageCount",o.path("pageCount"),"wordCount",o.path("wordCount"),"tableCount",o.path("tableCount"));item.set("result",summary==null?NullNode.instance:summary);result.add(item); }return result;
    }
    ObjectNode get(String id) throws Exception { return records.get(id); }
    Path source(JsonNode job) { return Documents.managed(config.input,job.path("storedName").asText()); }
    Path output(String id) { return Documents.managed(config.output,id+".json"); }
    ObjectNode raw(JsonNode job) throws Exception { Path path=output(job.path("id").asText());if(!Files.isRegularFile(path)) throw ApiError.missing();if(Files.size(path)>64L*1024*1024) throw ApiError.bad("OCR 결과가 너무 큽니다.");return Json.parse(Files.readString(path)); }
    ObjectNode normalized(JsonNode job) throws Exception { return Ocr.normalize(raw(job),job.path("pageSizes")); }
    ObjectNode view(String id) throws Exception { ObjectNode job=get(id);done(job);return Ocr.view(normalized(job)); }
    static void done(JsonNode job) { if(!job.path("status").asText().equals("done")) throw ApiError.bad("완료된 문서에서만 사용할 수 있습니다."); }
    ObjectNode patch(String id,ObjectNode changes,String event,String actor) throws Exception {
        return records.change(id,n->{
            if(n.path("status").asText().equals("cancelled")&&!changes.has("cancellation")) throw new ApiError(409,"CANCELLED","작업이 취소되었습니다.");
            String now=now(),type=event;
            if(type==null&&changes.has("status")&&!changes.path("status").equals(n.path("status"))) type="status."+changes.path("status").asText();
            if(type==null&&changes.has("engineStatus")&&!changes.path("engineStatus").equals(n.path("engineStatus"))) type="engine."+changes.path("engineStatus").asText();
            if(type!=null) { ArrayNode events=n.path("events").isArray()?((ArrayNode)n.get("events")):arr();ObjectNode e=obj("type",type,"at",now,"actor",actor);if(changes.hasNonNull("error")) e.set("message",changes.get("error"));events.add(e);while(events.size()>1000) events.remove(0);n.set("events",events); }
            n.setAll(changes);n.put("updatedAt",now);return n;
        });
    }
    void assertActive(String id) throws Exception { if(Thread.currentThread().isInterrupted()||get(id).path("status").asText().equals("cancelled")) throw new ApiError(409,"CANCELLED","작업이 취소되었습니다."); }
    ObjectNode create(ObjectNode input,String actor,boolean admin) throws Exception {
        lifecycle.readLock().lock();Path stored=null;String id=null;
        try {
            if(resetting) throw ApiError.bad("문서 초기화 중입니다. 잠시 후 다시 시도하세요.");
            if(workers.isShutdown()||workers.getQueue().remainingCapacity()==0) throw new ApiError(429,"QUEUE_FULL","작업 대기열이 가득 찼습니다. 잠시 후 다시 시도하세요.");
            String name=Documents.name(Json.string(input,"fileName")),ext=Documents.extension(name);
            if(!Documents.EXTENSIONS.contains(ext)) throw ApiError.bad("PDF·PNG·JPG·BMP·TIFF 문서를 선택하세요.");
            byte[] bytes=Documents.decode(Json.string(input,"contentBase64"));String templateId=Json.string(input,"templateId");ObjectNode template=templateId.isEmpty()?null:forms.get(templateId);
            if(input.hasNonNull("templateSnapshot")) { if(!admin) throw new ApiError(403,"FORBIDDEN","서식 미리보기는 관리자만 사용할 수 있습니다.");template=Templates.normalize(object(input.get("templateSnapshot"))); }
            ObjectNode split=Templates.object(input,"split"),options=Templates.object(input,"options");String mode=split.path("mode").asText("none");
            if(!Set.of("none","pages","blank","template").contains(mode)||mode.equals("pages")&&(!split.path("count").canConvertToInt()||split.path("count").asInt()<1||split.path("count").asInt()>10000)) throw ApiError.bad("문서 분리 방식을 확인하세요.");
            id=id("job");String storedName=id+"."+ext;stored=Documents.managed(config.input,storedName);Documents.atomic(stored,bytes);
            ArrayNode sizes;
            try { sizes=Documents.geometry(stored,config.pdfScale); }catch(Exception e) { throw ApiError.bad("원본 문서를 읽을 수 없습니다. 손상되거나 암호화된 PDF·이미지인지 확인하세요."); }
            validatePages(options.path("pages").asText("all"),sizes.size());
            ObjectNode job=obj("id",id,"fileName",name,"storedName",storedName,"templateId",templateId.isEmpty()?null:templateId,"templateSnapshot",template,"pageSizes",sizes,"split",split,"options",options,"parentId",input.get("parentId"),"relation",input.get("relation"),"status","pending","engineStatus",null,"taskId",null,"error",null,"ocrResult",null,"createdAt",now(),"updatedAt",now(),"events",arr(obj("type","created","at",now(),"actor",actor)));
            engineOptions(job);records.insert(job);String jobId=id;active.add(jobId);
            try { workers.execute(()->{try { run(jobId); }finally { active.remove(jobId); }}); }catch(RejectedExecutionException e) { active.remove(jobId);records.remove(jobId);throw new ApiError(429,"QUEUE_FULL","작업 대기열이 가득 찼습니다."); }
            return job;
        } catch(Exception e) { if(stored!=null) Files.deleteIfExists(stored);throw e; }
        finally { lifecycle.readLock().unlock(); }
    }
    static List<Integer> validatePages(String value,int max) {
        if(value.equals("all")) return List.of();TreeSet<Integer> pages=new TreeSet<>();
        if(value.length()>50000) throw ApiError.bad("페이지 지정이 너무 깁니다.");
        try { for(String range:value.split(",")) { if(!range.matches("[0-9]+(-[0-9]+)?")) throw new IllegalArgumentException();String[] pair=range.split("-");int a=Integer.parseInt(pair[0]),b=pair.length==2?Integer.parseInt(pair[1]):a;if(a<1||b<a||b>max||b-a>10000) throw new IllegalArgumentException();for(int n=a;n<=b;n++) pages.add(n); } }
        catch(IllegalArgumentException e) { throw ApiError.bad("인식할 페이지를 원본 범위 안에서 지정하세요."); }
        if(pages.isEmpty()) throw ApiError.bad("인식할 페이지가 없습니다.");return new ArrayList<>(pages);
    }
    ObjectNode engineOptions(JsonNode job) throws Exception {
        ObjectNode baseline=settings.find("engine");JsonNode base=baseline==null?obj():baseline.path("policy"),form=job.path("templateSnapshot"),request=form.path("engineRequest"),options=job.path("options");
        ObjectNode option=TextSense.merge(base.path("reqOption").isObject()?base.path("reqOption"):obj(),request.path("reqOption").isObject()?request.path("reqOption"):obj());
        if(options.path("reqOption").isObject()) option=TextSense.merge(option,options.path("reqOption"));
        if(options.path("plainText").asBoolean()) option.set("ResultOption",TextSense.merge(option.path("ResultOption").isObject()?option.path("ResultOption"):obj(),obj("Format","PlainText")));
        ObjectNode preprocess=option.path("PreProcessOption").isObject()?((ObjectNode)option.get("PreProcessOption")):obj();if(options.has("denoising")) preprocess.set("denoising",options.get("denoising"));if(options.has("scaleUp")) preprocess.set("ScaleUp",options.get("scaleUp"));if(!preprocess.isEmpty()) option.set("PreProcessOption",preprocess);
        if(options.has("customSetting")) option.set("CustomSetting",TextSense.merge(option.path("CustomSetting").isObject()?option.path("CustomSetting"):obj(),options.path("customSetting")));
        ArrayNode rules=arr();for(JsonNode source:List.of(base.path("reqOption").path("SearchAPI"),request.path("reqOption").path("SearchAPI"),options.path("reqOption").path("SearchAPI"))) for(JsonNode rule:items(source)) rules.add(rule);
        for(JsonNode k:items(form.path("keys"))) if(!k.path("searchType").asText().isEmpty()) {
            String type=k.path("searchType").asText();ArrayNode key;
            if(type.equals("FindRegion")) { JsonNode size=job.path("pageSizes").path(k.path("page").asInt(1)-1),r=k.path("rect");if(size.isMissingNode()) throw ApiError.bad("SearchAPI 영역의 원본 페이지 크기를 확인할 수 없습니다.");key=arr(arr(r.path("x").asDouble()*size.path("width").asDouble(),r.path("y").asDouble()*size.path("height").asDouble()),arr((r.path("x").asDouble()+r.path("w").asDouble())*size.path("width").asDouble(),(r.path("y").asDouble()+r.path("h").asDouble())*size.path("height").asDouble())); }
            else { if(k.path("searchKey").asText().isBlank()) throw ApiError.bad("SearchAPI 탐색 기준 단어가 필요합니다.");key=arr(k.path("searchKey")); }
            rules.add(obj("Type",type,"Name",k.path("name"),"Key",key));
        }
        for(JsonNode rule:items(options.path("searchApi"))) rules.add(obj("Type",rule.path("type"),"Name",rule.path("name"),"Key",rule.path("key")));
        Set<String> seen=new HashSet<>();for(JsonNode r:rules) if(!seen.add(r.path("Name").asText())) throw ApiError.bad("기존·서식·요청 정책의 SearchAPI 이름이 중복됩니다.");
        if(!rules.isEmpty()) option.set("SearchAPI",rules);Templates.validateOptions(option);
        return obj("reqType",request.path("reqType").asText(base.path("reqType").asText("Document")),"reqOption",option,"pages",options.path("pages").asText("all"));
    }
    String signature(String name,long expires) throws Exception { Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(signingSecret,"HmacSHA256"));return HexFormat.of().formatHex(mac.doFinal((name+":"+expires).getBytes(StandardCharsets.UTF_8))); }
    String signed(String name) throws Exception { long expires=System.currentTimeMillis()+Math.max(900000,config.jobTimeout+60000);return expires+"."+signature(name,expires); }
    boolean verify(String name,String token) {
        try { if(token==null||!token.matches("[0-9]+\\.[a-f0-9]{64}")) return false;String[] parts=token.split("\\.");long expires=Long.parseLong(parts[0]);return expires>=System.currentTimeMillis()&&Passwords.equal(parts[1],signature(name,expires)); }catch(Exception e) { return false; }
    }
    String inputUri(String name) throws Exception {
        if(config.publicUrl.isEmpty()) return config.inputUri+"/"+name;
        String base=config.publicUrl.equals("auto")?"http://"+config.localHost()+":"+RuntimeConfig.env("FORMREADER_INPUT_PORT","18080"):config.publicUrl;
        return base+"/files/input/"+name+"?token="+signed(name);
    }
    String outputUri(String name) throws Exception { return config.ftpEnabled?"ftp://"+URLEncoder.encode(config.ftpUser,StandardCharsets.UTF_8)+":"+URLEncoder.encode(config.ftpPassword,StandardCharsets.UTF_8)+"@"+config.ftpPublicHost()+":"+config.ftpPort+"/"+name:config.outputUri+"/"+name; }
    ObjectNode recognize(String id) throws Exception {
        ObjectNode job=get(id);String name=id+".json";ftp.expect(name);
        TextSense.Reply accepted=client.build(inputUri(job.path("storedName").asText()),outputUri(name),engineOptions(job));
        if(accepted.status()<200||accepted.status()>=300||!accepted.body().hasNonNull("id")) throw new ApiError(502,"UPSTREAM_ERROR","TextSense 작업 접수 실패 (HTTP "+accepted.status()+")");
        String task=accepted.body().path("id").asText();patch(id,obj("taskId",task,"engineStatus",accepted.body().path("status").asText("AWAITING")),null,null);
        long deadline=System.currentTimeMillis()+config.jobTimeout;int transientErrors=0;boolean success=false;
        while(System.currentTimeMillis()<deadline) {
            assertActive(id);TextSense.Reply r;
            try { r=client.status(task);if(r.status()>=500) throw new java.io.IOException("Status HTTP "+r.status()); }
            catch(Exception e) { if(++transientErrors>5) throw e;Thread.sleep(config.poll);continue; }
            transientErrors=0;if(r.status()!=200) throw new ApiError(502,"UPSTREAM_ERROR","OCR 상태 조회 실패 (HTTP "+r.status()+")");
            String status=r.body().path("status").asText();if(!get(id).path("engineStatus").asText().equals(status)) patch(id,obj("engineStatus",status),null,null);
            if(status.equals("SUCCESS")) { success=true;break; }if(status.equals("FAILURE")) throw new ApiError(502,"UPSTREAM_ERROR",client.failure(task));Thread.sleep(config.poll);
        }
        if(!success) throw new ApiError(504,"TIMEOUT","OCR 작업 대기 시간이 초과됐습니다.");
        long wait=System.currentTimeMillis()+config.outputWait;ObjectNode raw=null;
        while(System.currentTimeMillis()<wait) { assertActive(id);try { raw=raw(job);break; }catch(ApiError|java.io.IOException e) { Thread.sleep(Math.min(config.poll,500)); } }
        if(raw==null) throw new ApiError(504,"TIMEOUT","OCR은 성공했지만 결과 파일을 받지 못했습니다. 공유 저장소·FTP 수신 주소와 방화벽을 확인하세요.");
        List<Integer> selected=validatePages(job.path("options").path("pages").asText("all"),job.path("pageSizes").size());
        if(!selected.isEmpty()) { ObjectNode remapped=obj();List<String> keys=new ArrayList<>(names(raw.path("document").path("pages")));keys.sort(Comparator.comparingInt(Nodes::page));if(keys.size()!=selected.size()) throw new ApiError(502,"UPSTREAM_ERROR","요청한 페이지 수와 OCR 결과가 일치하지 않습니다.");for(int i=0;i<keys.size();i++) remapped.set("pages_"+selected.get(i),raw.path("document").path("pages").get(keys.get(i)));((ObjectNode)raw.path("document")).set("pages",remapped);Documents.atomic(output(id),Json.MAPPER.writeValueAsBytes(raw)); }
        return raw;
    }
    void run(String id) {
        try {
            assertActive(id);patch(id,obj("status","processing"),null,null);ObjectNode raw=recognize(id),job=get(id),normalized=Ocr.normalize(raw,job.path("pageSizes"));
            ObjectNode template=job.path("templateSnapshot").isObject()?((ObjectNode)job.get("templateSnapshot")):Ocr.classify(forms.list(),normalized);
            if(!job.path("templateSnapshot").isObject()&&template!=null) {
                patch(id,obj("templateId",template.get("id"),"templateSnapshot",template),"template.classified",null);
                if(!template.path("engineRequest").path("reqOption").isEmpty()||items(template.path("keys")).stream().anyMatch(k->!k.path("searchType").asText().isEmpty())) {
                    assertActive(id);Files.move(output(id),Documents.managed(config.output,id+".classification.json"),StandardCopyOption.REPLACE_EXISTING);patch(id,obj("engineStatus","AWAITING"),"template.enginePass",null);raw=recognize(id);normalized=Ocr.normalize(raw,job.path("pageSizes"));
                }
            }
            assertActive(id);patch(id,obj("status","done","ocrResult",Ocr.apply(normalized,template,true),"error",null),null,null);
            JsonNode split=job.path("split");if(!split.path("mode").asText("none").equals("none")) try { autoSplit(id,split); }catch(Exception e) { patch(id,obj("splitError",TextSense.redact(e.getMessage())),"split.failed",null); }
            if(workspace!=null) try { workspace.autoDeliver(id); }catch(Exception e) { patch(id,obj("deliveryError",TextSense.redact(e.getMessage())),"delivery.failed",null); }
        } catch(Exception e) {
            try { if(!get(id).path("status").asText().equals("cancelled")) patch(id,obj("status","failed","error",TextSense.redact(e.getMessage()==null?"문서 처리 실패":e.getMessage()),"errorCode",e instanceof ApiError a?a.code:"PROCESSING_ERROR"),null,null); }catch(Exception ignored) {}
        } finally { ftp.forget(id+".json"); }
    }
    ObjectNode cancel(String id,String actor) throws Exception {
        ObjectNode job=records.change(id,n->{if(!Set.of("pending","processing").contains(n.path("status").asText())) throw ApiError.bad("진행 중인 작업만 취소할 수 있습니다.");ArrayNode events=(ArrayNode)n.path("events");events.add(obj("type","status.cancelled","at",now(),"actor",actor));n.put("status","cancelled").put("updatedAt",now());n.set("cancellation",obj("scope","application","engineStopped",false,"message","앱의 후속 처리를 중단했습니다. 엔진 중단 여부는 확인되지 않았습니다."));return n;});
        if(!config.cancelPath.isEmpty()&&job.hasNonNull("taskId")) try { TextSense.Reply r=client.call(config.cancelPath,obj("type","OBJECT_ID","id",job.path("taskId")));boolean accepted=r.status()>=200&&r.status()<300,stopped=accepted&&Set.of("CANCELLED","CANCELED","STOPPED").contains(r.body().path("status").asText());patch(id,obj("cancellation",obj("scope",stopped?"engine":accepted?"engine-request":"application","engineStopped",stopped,"requestAccepted",accepted,"message",stopped?"엔진 중단 상태를 확인했습니다.":"앱의 후속 처리는 중단됐으며 엔진 중단 상태는 확인되지 않았습니다.")),null,actor); }catch(Exception ignored) {}
        return get(id);
    }
    ObjectNode retry(String id,String actor) throws Exception { ObjectNode job=get(id);if(!job.path("status").asText().equals("failed")) throw ApiError.bad("실패한 문서만 재처리할 수 있습니다.");return create(obj("fileName",job.path("fileName"),"contentBase64",Base64.getEncoder().encodeToString(Files.readAllBytes(source(job))),"templateId",job.path("templateId"),"options",job.path("options").isObject()?job.path("options"):obj(),"parentId",id,"relation","retry"),actor,false); }
    ObjectNode remove(String id) throws Exception { ObjectNode job=get(id);if(Set.of("pending","processing").contains(job.path("status").asText())) throw ApiError.bad("진행 중인 작업은 취소 후 삭제하세요.");records.remove(id);return obj("id",id); }
    ObjectNode reapply(String id,String templateId,String actor) throws Exception { ObjectNode job=get(id);done(job);ObjectNode normalized=normalized(job),template=templateId.isEmpty()?Ocr.classify(forms.list(),normalized):forms.get(templateId);return patch(id,obj("templateId",template==null?null:template.get("id"),"templateSnapshot",template,"ocrResult",Ocr.apply(normalized,template,false),"review",null),"template.reapplied",actor); }
    ObjectNode review(String id,ObjectNode input,String actor) throws Exception {
        ObjectNode job=get(id);done(job);ObjectNode submitted=Templates.object(input,"values"),groupInput=Templates.object(input,"groups"),values=obj(),groups=obj();JsonNode original=job.path("ocrResult").path("values"),template=job.path("templateSnapshot");
        if(!names(original).equals(names(submitted))) throw ApiError.bad("문서의 추출 항목과 검수 항목이 일치하지 않습니다.");
        if(input.has("confirmed")&&!input.get("confirmed").isBoolean()) throw ApiError.bad("검수 완료 여부는 true 또는 false여야 합니다.");boolean confirmed=input.path("confirmed").asBoolean(),valid=true;
        for(String name:names(original)) { String value=Json.string(submitted,name).trim();if(value.length()>50000) throw ApiError.bad("검수 항목은 5만 자 이내여야 합니다.");JsonNode key=items(template.path("keys")).stream().filter(k->k.path("name").asText().equals(name)).findFirst().orElse(obj());ArrayNode errors=Ocr.validate(key,value);valid&=errors.isEmpty();values.set(name,obj("value",value,"valid",errors.isEmpty(),"errors",errors,"originalValue",original.path(name).path("value"))); }
        JsonNode originalGroups=job.path("ocrResult").path("groups");if(!names(originalGroups).containsAll(names(groupInput))) throw ApiError.bad("알 수 없는 반복 그룹입니다.");
        for(String name:names(originalGroups)) {
            JsonNode group=originalGroups.path(name),definition=items(template.path("groups")).stream().filter(g->g.path("name").asText().equals(name)).findFirst().orElse(obj());ArrayNode rows=arr();JsonNode submittedRows=groupInput.get(name);
            if(submittedRows!=null&&(!submittedRows.isArray()||submittedRows.size()!=group.path("rows").size())) throw ApiError.bad("반복 그룹 행 수가 원본과 일치해야 합니다.");
            for(int i=0;i<group.path("rows").size();i++) { JsonNode originalRow=group.path("rows").get(i),row=submittedRows==null?null:submittedRows.get(i);Set<String> columns=new LinkedHashSet<>();group.path("columns").forEach(c->columns.add(c.asText()));if(row!=null&&(!row.isObject()||!names(row).equals(columns))) throw ApiError.bad("Sub 키 검수 항목이 일치하지 않습니다.");ObjectNode cells=obj();
                for(String column:columns) { String value=row==null?originalRow.path("values").path(column).path("value").asText():Json.string(row,column).trim();if(value.length()>50000) throw ApiError.bad("Sub 키는 5만 자 이내여야 합니다.");JsonNode key=items(definition.path("columns")).stream().filter(c->c.path("name").asText().equals(column)).findFirst().orElse(obj());ArrayNode errors=Ocr.validate(key,value);valid&=errors.isEmpty();cells.set(column,obj("value",value,"valid",errors.isEmpty(),"errors",errors,"originalValue",originalRow.path("values").path(column).path("value"))); }rows.add(obj("page",originalRow.path("page"),"values",cells)); }
            groups.set(name,obj("columns",group.path("columns"),"rows",rows));
        }
        if(confirmed&&!valid) throw ApiError.bad("검증 규칙에 맞지 않는 항목이 있습니다. 수정하거나 임시 저장하세요.");
        ObjectNode review=obj("values",values,"groups",groups,"confirmed",confirmed,"savedAt",now());if(input.has("text")) { String text=Json.string(input,"text");if(text.length()>5_000_000) throw ApiError.bad("검수 본문은 500만 자 이내여야 합니다.");review.put("text",text); }
        return patch(id,obj("review",review),"review.saved",actor);
    }
    ArrayNode split(String id,JsonNode groups,String actor) throws Exception {
        lifecycle.readLock().lock();try {
            if(resetting) throw ApiError.bad("문서 초기화 중입니다.");
            ObjectNode job=get(id);done(job);if(!groups.isArray()||groups.isEmpty()||groups.size()>500) throw ApiError.bad("분리할 페이지 그룹을 지정하세요.");
            ObjectNode raw=raw(job);Set<Integer> available=new HashSet<>();for(String key:names(raw.path("document").path("pages"))) available.add(page(key));Set<Integer> used=new HashSet<>();
            for(JsonNode group:groups) { if(!group.isArray()||group.isEmpty()) throw ApiError.bad("분리 페이지 그룹을 확인하세요.");for(JsonNode n:group) if(!n.isIntegralNumber()||!available.contains(n.asInt())||!used.add(n.asInt())) throw ApiError.bad("페이지를 중복 없이 원본 OCR 범위 안에서 지정하세요."); }
            ArrayNode children=arr();
            for(JsonNode group:groups) {
                List<Integer> numbers=items(group).stream().map(JsonNode::asInt).toList();String childId=id("job"),stored=childId+".pdf";ObjectNode childRaw=raw.deepCopy(),pages=obj();ArrayNode sizes=arr();int i=1;
                for(int n:numbers) { pages.set("pages_"+i++,raw.path("document").path("pages").path("pages_"+n));sizes.add(job.path("pageSizes").path(n-1)); }
                ((ObjectNode)childRaw.path("document")).set("pages",pages);Documents.atomic(Documents.managed(config.input,stored),Documents.split(source(job),numbers));Documents.atomic(output(childId),Json.MAPPER.writeValueAsBytes(childRaw));
                ObjectNode normalized=Ocr.normalize(childRaw,sizes),template=Ocr.classify(forms.list(),normalized),child=obj("id",childId,"fileName",job.path("fileName").asText().replaceFirst("\\.[^.]+$","")+"_"+numbers.stream().map(Object::toString).collect(java.util.stream.Collectors.joining("-"))+".pdf","storedName",stored,"status","done","engineStatus","SUCCESS","taskId",job.path("taskId"),"templateId",template==null?null:template.get("id"),"templateSnapshot",template,"ocrResult",Ocr.apply(normalized,template,true),"pageSizes",sizes,"parentId",id,"relation","split","sourcePages",group,"createdAt",now(),"updatedAt",now(),"events",arr(obj("type","split.created","at",now(),"actor",actor)));
                records.insert(child);children.add(child);
            }
            records.change(id,n->{ArrayNode ids=n.path("children").isArray()?(ArrayNode)n.get("children"):arr();for(JsonNode child:children) ids.add(child.path("id"));n.set("children",ids);n.put("updatedAt",now());return n;});patch(id,obj(),"document.split",actor);return children;
        }finally { lifecycle.readLock().unlock(); }
    }
    void autoSplit(String id,JsonNode option) throws Exception {
        ObjectNode job=get(id),normalized=normalized(job);ArrayNode groups=arr(),current=arr();String previous=null;int count=option.path("count").asInt(1);
        for(JsonNode p:normalized.path("pages")) {
            String mode=option.path("mode").asText();if(mode.equals("blank")&&p.path("content").asText().isBlank()&&p.path("words").isEmpty()) { if(!current.isEmpty()) groups.add(current);current=arr();continue; }
            String type="";if(mode.equals("template")) { ObjectNode t=Ocr.classify(forms.list(),obj("pages",arr(p)));type=t==null?"unclassified":t.path("id").asText(); }
            if(!current.isEmpty()&&(mode.equals("pages")&&current.size()>=count||mode.equals("template")&&!type.equals(previous))) { groups.add(current);current=arr(); }
            current.add(p.path("page"));previous=type;
        }
        if(!current.isEmpty()) groups.add(current);if(!groups.isEmpty()) split(id,groups,null);
    }
    ObjectNode diagnostics(String id) throws Exception {
        ObjectNode j=get(id);ArrayNode stages=arr(),hints=arr();String last=null;
        for(JsonNode e:items(j.path("events"))) { ObjectNode stage=e.deepCopy();long elapsed=last==null?0:Math.max(0,Instant.parse(e.path("at").asText()).toEpochMilli()-Instant.parse(last).toEpochMilli());stage.put("elapsedMs",elapsed);stages.add(stage);last=e.path("at").asText(); }
        if(j.path("status").asText().equals("failed")) hints.add("VPN·OCR 게이트웨이·결과 수신 경로와 아래 이력을 확인하세요. 원본이 보관돼 있으면 재처리할 수 있습니다.");
        return obj("id",id,"fileName",j.path("fileName"),"status",j.path("status"),"sourcePresent",Files.isRegularFile(source(j)),"resultPresent",Files.isRegularFile(output(id)),"error",j.get("error"),"errorCode",j.get("errorCode"),"engineStatus",j.get("engineStatus"),"createdAt",j.path("createdAt"),"updatedAt",j.path("updatedAt"),"totalElapsedMs",Math.max(0,Instant.parse(j.path("updatedAt").asText()).toEpochMilli()-Instant.parse(j.path("createdAt").asText()).toEpochMilli()),"hints",hints,"stages",stages,"cancellation",j.get("cancellation"));
    }
    void idle() throws InterruptedException { while(!active.isEmpty()) Thread.sleep(25); }
    @Override public void close() { workers.shutdownNow();try { workers.awaitTermination(5,TimeUnit.SECONDS); }catch(InterruptedException e) { Thread.currentThread().interrupt(); }ftp.close(); }
}
