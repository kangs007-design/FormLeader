package com.textsense.product;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import static com.textsense.product.Nodes.*;

/** TextSense document.pages normalization and template extraction. No external process. */
final class Ocr {
    static double num(JsonNode n, double fallback) { return n.isNumber() && Double.isFinite(n.asDouble()) ? n.asDouble() : fallback; }
    static ObjectNode rect(JsonNode points) {
        if (!points.isArray() || points.size() < 2) return null;
        double x1 = Double.POSITIVE_INFINITY, y1 = x1, x2 = Double.NEGATIVE_INFINITY, y2 = x2;
        for (JsonNode p : points) if (p.isArray() && p.size() >= 2 && p.get(0).isNumber() && p.get(1).isNumber()) {
            x1 = Math.min(x1, p.get(0).asDouble()); x2 = Math.max(x2, p.get(0).asDouble());
            y1 = Math.min(y1, p.get(1).asDouble()); y2 = Math.max(y2, p.get(1).asDouble());
        }
        return Double.isFinite(x1) && Double.isFinite(y1) && Double.isFinite(x2) && Double.isFinite(y2) ? obj("x1",x1,"y1",y1,"x2",x2,"y2",y2) : null;
    }
    static String elementText(JsonNode el) {
        JsonNode value = el.path("recognition").path("content");
        return text(value.isMissingNode() || value.isNull() ? el.path("content") : value).trim();
    }
    static JsonNode confidence(JsonNode el) {
        JsonNode value = el.path("recognition").path("confidence"); double n = Double.NaN;
        if (value.isArray() && !value.isEmpty()) n = items(value).stream().mapToDouble(v -> v.asDouble()).average().orElse(Double.NaN);
        else if (value.isNumber()) n = value.asDouble();
        if (!Double.isFinite(n) || n == 0) n = num(el.path("detection").path("confidence"), Double.NaN);
        return Double.isFinite(n) ? DoubleNode.valueOf(Math.round(n * 1000) / 1000.0) : NullNode.instance;
    }
    static List<JsonNode> words(JsonNode elements) {
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode el : items(elements)) {
            String type = el.path("type").asText(); JsonNode children = el.path(type.equals("table") ? "cells" : "texts");
            if (children.isArray() && !children.isEmpty()) { out.addAll(words(children)); continue; }
            if (Set.of("table","cell").contains(type)) continue;
            ObjectNode box = rect(el.path("points")); String t = elementText(el);
            if (box != null && !t.isEmpty()) { box.put("text", t).set("conf", confidence(el)); out.add(box); }
        }
        return out;
    }
    static List<JsonNode> units(JsonNode elements) {
        List<JsonNode> result = new ArrayList<>();
        for (JsonNode el : items(elements)) {
            String type = el.path("type").asText(); ObjectNode box = rect(el.path("points"));
            if (box != null && Set.of("cell","textline").contains(type)) {
                String value = elementText(el); if (value.isEmpty()) value = words(el.path("texts")).stream().map(w -> w.path("text").asText()).collect(Collectors.joining(" "));
                box.put("type",type).put("text",value); result.add(box);
            }
            result.addAll(units(el.path(type.equals("table") ? "cells" : "texts")));
        }
        return result;
    }
    static ArrayNode tables(JsonNode elements) {
        ArrayNode out = arr();
        for (JsonNode table : items(elements)) if (table.path("type").asText().equals("table")) {
            ArrayNode cells = arr(); int rows = table.path("num_rows").asInt(), cols = table.path("num_cols").asInt();
            for (JsonNode c : items(table.path("cells"))) {
                int r = c.path("row_index").asInt(), col = c.path("column_index").asInt();
                if (r < 0 || col < 0 || r > 10000 || col > 1000) throw ApiError.bad("OCR 표의 행·열 범위가 올바르지 않습니다.");
                String value = c.hasNonNull("content") ? c.path("content").asText().trim() : words(c.path("texts")).stream().map(w -> w.path("text").asText()).collect(Collectors.joining(" "));
                cells.add(obj("row",r,"col",col,"text",value,"rect",rect(c.path("points")))); rows = Math.max(rows,r+1); cols = Math.max(cols,col+1);
            }
            if (rows < 0 || cols < 0 || (long) rows * cols > 1_000_000) throw ApiError.bad("OCR 표 크기가 제한을 초과했습니다.");
            ArrayNode grid = arr(); for(int r=0;r<rows;r++) { ArrayNode row = arr(); for(int c=0;c<cols;c++) row.add(""); grid.add(row); }
            for(JsonNode c:cells) ((ArrayNode)grid.get(c.path("row").asInt())).set(c.path("col").asInt(),TextNode.valueOf(c.path("text").asText()));
            out.add(obj("rows",rows,"cols",cols,"grid",grid,"cells",cells,"rect",rect(table.path("points"))));
        }
        return out;
    }
    static ArrayNode fields(JsonNode fields) {
        ArrayNode result = arr();
        for(String name:names(fields)) {
            JsonNode entry=fields.get(name), list=entry.isArray()?entry:entry.path("values"); ArrayNode collected=arr();
            List<JsonNode> values=words(list);
            if(values.isEmpty()) for(JsonNode value:items(list)) { String s=elementText(value); if(!s.isEmpty()) collected.add(obj("text",s,"conf",confidence(value))); }
            else for(JsonNode value:values) collected.add(obj("text",value.path("text"),"conf",value.path("conf")));
            result.add(obj("name",name,"text",items(collected).stream().map(v->v.path("text").asText()).collect(Collectors.joining(" ")),"items",collected));
        }
        return result;
    }
    static ObjectNode normalize(JsonNode raw, JsonNode sizes) {
        JsonNode dict=raw.path("document").path("pages");
        if(!dict.isObject()) throw ApiError.bad("OCR 결과에 document.pages가 없습니다.");
        ArrayNode pages=arr();
        List<String> keys=new ArrayList<>(names(dict)); keys.sort(Comparator.comparingInt(Nodes::page));
        if(keys.size()>10000) throw ApiError.bad("OCR 페이지가 너무 많습니다.");
        for(String key:keys) {
            JsonNode p=dict.get(key); int no=page(key); if(no==0) no=pages.size()+1;
            List<JsonNode> ws=words(p.path("elements")), us=units(p.path("elements"));
            JsonNode known=sizes.path(no-1); if(known.isMissingNode()) known=sizes.path(pages.size());
            double width=num(p.path("width"),num(p.path("image_width"),num(p.path("size").path("width"),known.path("width").asDouble())));
            double height=num(p.path("height"),num(p.path("image_height"),num(p.path("size").path("height"),known.path("height").asDouble())));
            String source=width>0&&height>0?(p.has("width")||p.has("image_width")||p.path("size").has("width")?"engine":known.path("source").asText("image")):"estimated";
            if(width<=0||height<=0) { width=ws.stream().mapToDouble(w->w.path("x2").asDouble()).max().orElse(1); height=ws.stream().mapToDouble(w->w.path("y2").asDouble()).max().orElse(1); }
            width=Math.max(1,width); height=Math.max(1,height);
            for(JsonNode w:concat(ws,us)) ((ObjectNode)w).put("cx",(w.path("x1").asDouble()+w.path("x2").asDouble())/2/width).put("cy",(w.path("y1").asDouble()+w.path("y2").asDouble())/2/height).put("h",(w.path("y2").asDouble()-w.path("y1").asDouble())/height);
            String content=p.path("content").asText().trim(); if(content.isEmpty()) content=lines(ws,0.5).stream().map(Ocr::joinWords).collect(Collectors.joining("\n"));
            pages.add(obj("page",no,"content",content,"orientation",p.path("orientation").asInt(),"width",width,"height",height,"sizeSource",source,"words",ws,"units",us,"tables",tables(p.path("elements")),"fields",fields(p.path("fields"))));
        }
        return obj("pages",pages);
    }
    static List<JsonNode> concat(List<JsonNode>a,List<JsonNode>b) { List<JsonNode>r=new ArrayList<>(a);r.addAll(b);return r; }
    static List<List<JsonNode>> lines(List<JsonNode> words,double tolerance) {
        List<JsonNode> sorted=new ArrayList<>(words); sorted.sort(Comparator.comparingDouble((JsonNode w)->w.path("cy").asDouble()).thenComparingDouble(w->w.path("cx").asDouble()));
        List<List<JsonNode>> lines=new ArrayList<>();
        for(JsonNode w:sorted) {
            List<JsonNode> found=null;
            for(List<JsonNode> line:lines) if(Math.abs(line.getFirst().path("cy").asDouble()-w.path("cy").asDouble())<=Math.max(line.getFirst().path("h").asDouble(),w.path("h").asDouble())*tolerance) { found=line;break; }
            if(found==null) { found=new ArrayList<>();lines.add(found); } found.add(w);
        }
        return lines;
    }
    static String joinWords(List<JsonNode> words) { return lines(words,0.5).stream().map(line->line.stream().sorted(Comparator.comparingDouble(w->w.path("cx").asDouble())).map(w->w.path("text").asText()).collect(Collectors.joining(" "))).collect(Collectors.joining(" ")).trim(); }
    static boolean inside(JsonNode word,JsonNode rect) { double x=word.path("cx").asDouble(),y=word.path("cy").asDouble(); return x>=rect.path("x").asDouble()&&x<=rect.path("x").asDouble()+rect.path("w").asDouble()&&y>=rect.path("y").asDouble()&&y<=rect.path("y").asDouble()+rect.path("h").asDouble(); }
    static String select(JsonNode key,JsonNode p) {
        List<JsonNode> words=items(p.path("words")).stream().filter(w->inside(w,key.path("rect"))).toList();
        String search=key.path("searchType").asText(),anchor=key.path("searchKey").asText();
        if(!search.isEmpty()) {
            if(search.equals("FindRegion")) return joinWords(words);
            if(anchor.isEmpty()) return "";
            List<JsonNode> all=items(p.path("words"));
            if(search.equals("FindWord")) return joinWords(all.stream().filter(w->w.path("text").asText().contains(anchor)).toList());
            if(search.equals("FindLine")) return lines(all,0.6).stream().filter(l->l.stream().anyMatch(w->w.path("text").asText().contains(anchor))).findFirst().map(Ocr::joinWords).orElse("");
            for(JsonNode table:items(p.path("tables"))) for(JsonNode cell:items(table.path("cells"))) if(cell.path("text").asText().contains(anchor)) {
                int r=cell.path("row").asInt(),c=cell.path("col").asInt();
                return items(table.path("cells")).stream().filter(v->switch(search) { case "FindRow"->v.path("row").asInt()==r; case "FindRightRow"->v.path("row").asInt()==r&&v.path("col").asInt()>c; case "FindCol"->v.path("col").asInt()==c; default->v.path("col").asInt()==c&&v.path("row").asInt()>r; }).sorted(Comparator.comparingInt((JsonNode v)->v.path("row").asInt()).thenComparingInt(v->v.path("col").asInt())).map(v->v.path("text").asText()).collect(Collectors.joining(" "));
            }
            return "";
        }
        return switch(key.path("mode").asText()) {
            case "word"-> { List<JsonNode> sorted=new ArrayList<>(words);sorted.sort(Comparator.comparingDouble((JsonNode w)->w.path("cy").asDouble()).thenComparingDouble(w->w.path("cx").asDouble()));int i=key.path("wordIndex").asInt();yield i<sorted.size()?sorted.get(i).path("text").asText():""; }
            case "line"-> { List<List<JsonNode>> ls=lines(words,0.6);int i=key.path("lineIndex").asInt();yield key.has("lineIndex")?(i<ls.size()?joinWords(ls.get(i)):""):ls.stream().map(Ocr::joinWords).collect(Collectors.joining("\n")); }
            case "cell"-> key.has("row")&&key.has("column")?p.path("tables").path(key.path("tableIndex").asInt()).path("grid").path(key.path("row").asInt()).path(key.path("column").asInt()).asText():items(p.path("units")).stream().filter(u->u.path("type").asText().equals("cell")&&inside(u,key.path("rect"))).map(u->u.path("text").asText()).collect(Collectors.joining("\n"));
            default->joinWords(words);
        };
    }
    static boolean matches(String regex,String value,int flags) { return !regex.isEmpty()&&Pattern.compile(regex,flags).matcher(value).find(); }
    static ArrayNode validate(JsonNode key,String value) {
        ArrayNode errors=arr();
        if(items(key.path("exceptValues")).stream().anyMatch(v->v.asText().equals(value))||matches(key.path("exceptPattern").asText(),value,0)) return errors;
        if(key.path("required").asBoolean()&&value.isEmpty()) errors.add("필수값 누락");
        if(value.isEmpty()) return errors;
        for(String field:List.of("pattern","pattern2")) if(!key.path(field).asText().isEmpty()&&!matches(key.path(field).asText(),value,0)) errors.add((field.equals("pattern")?"형식 불일치(":"보조 형식 불일치(")+key.path(field).asText()+")");
        boolean min=key.hasNonNull("min"),max=key.hasNonNull("max");
        if(min||max) try { double n=Double.parseDouble(value.replaceAll("[,\\s원]",""));if(!Double.isFinite(n)) throw new NumberFormatException(); if(min&&n<key.path("min").asDouble()) errors.add("최소값("+key.path("min").asText()+") 미만");if(max&&n>key.path("max").asDouble()) errors.add("최대값("+key.path("max").asText()+") 초과"); } catch(NumberFormatException e) { errors.add("숫자 아님"); }
        return errors;
    }
    static ObjectNode group(JsonNode group,JsonNode ocr) {
        ArrayNode rows=arr(),columns=arr(); for(JsonNode c:items(group.path("columns"))) columns.add(c.path("name").asText());
        for(JsonNode page:items(ocr.path("pages"))) if(group.path("allPages").asBoolean()?page.path("page").asInt()>=group.path("page").asInt(1):page.path("page").asInt()==group.path("page").asInt(1)) {
            List<JsonNode> words=items(page.path("words")).stream().filter(w->inside(w,group.path("rect"))).toList();
            List<List<JsonNode>> lines;
            if(group.path("rowHeight").asDouble()>0) { Map<Integer,List<JsonNode>> bins=new TreeMap<>();for(JsonNode w:words) bins.computeIfAbsent((int)Math.floor((w.path("cy").asDouble()-group.path("rect").path("y").asDouble())/group.path("rowHeight").asDouble()),k->new ArrayList<>()).add(w);lines=new ArrayList<>(bins.values()); } else lines=lines(words,0.6);
            List<JsonNode> cells=items(page.path("tables").path(group.path("tableIndex").asInt()).path("grid"));boolean table=group.path("source").asText().equals("table");
            int count=table?cells.size():lines.size();
            for(int i=group.path("skipRows").asInt();i<count&&i<10000;i++) {
                ObjectNode values=obj();int index=0;
                for(JsonNode c:items(group.path("columns"))) {
                    String value;
                    if(table) value=cells.get(i).path(c.path("column").asInt(index)).asText();
                    else { double left=group.path("rect").path("x").asDouble()+c.path("rect").path("x").asDouble()*group.path("rect").path("w").asDouble(),right=left+c.path("rect").path("w").asDouble()*group.path("rect").path("w").asDouble();value=joinWords(lines.get(i).stream().filter(w->w.path("cx").asDouble()>=left&&w.path("cx").asDouble()<=right).toList()); }
                    ArrayNode errors=validate(c,value);values.set(c.path("name").asText(),obj("value",value,"valid",errors.isEmpty(),"errors",errors));index++;
                }
                if(names(values).stream().anyMatch(n->!values.path(n).path("value").asText().isEmpty())) rows.add(obj("page",page.path("page"),"values",values));
            }
        }
        return obj("columns",columns,"rows",rows);
    }
    static ObjectNode classify(JsonNode templates,JsonNode ocr) {
        String text=items(ocr.path("pages")).stream().map(p->p.path("content").asText()+"\n"+items(p.path("words")).stream().map(w->w.path("text").asText()).collect(Collectors.joining(" "))).collect(Collectors.joining("\n")).toLowerCase(Locale.ROOT);
        ObjectNode best=null;
        for(JsonNode t:items(templates)) {
            JsonNode rule=t.path("documentRule");List<JsonNode> keywords=items(t.path("keywords"));
            if(matches(rule.path("exceptPattern").asText(),text,Pattern.CASE_INSENSITIVE|Pattern.UNICODE_CASE)||keywords.isEmpty()&&rule.path("pattern").asText().isEmpty()) continue;
            if(keywords.stream().allMatch(k->text.contains(k.asText().toLowerCase(Locale.ROOT)))&&(rule.path("pattern").asText().isEmpty()||matches(rule.path("pattern").asText(),text,Pattern.CASE_INSENSITIVE|Pattern.UNICODE_CASE))&&(best==null||keywords.size()>best.path("keywords").size())) best=(ObjectNode)t;
        }
        return best;
    }
    static ObjectNode apply(JsonNode ocr,ObjectNode template,boolean engineFields) {
        List<JsonNode> pages=items(ocr.path("pages"));ObjectNode result=obj("pageCount",pages.size(),"wordCount",pages.stream().mapToInt(p->p.path("words").size()).sum(),"tableCount",pages.stream().mapToInt(p->p.path("tables").size()).sum(),"fieldCount",pages.stream().mapToInt(p->p.path("fields").size()).sum());
        String preview=pages.isEmpty()?"":pages.getFirst().path("content").asText().replaceAll("\\s+"," ");result.put("preview",preview.substring(0,Math.min(120,preview.length())));
        if(template==null) { result.setAll(obj("classified",false,"templateId",null,"docType",null,"values",obj(),"groups",obj(),"needsReview",true));return result; }
        ObjectNode values=obj(),groups=obj();boolean needs=false;
        for(JsonNode k:items(template.path("keys"))) {
            JsonNode p=pages.stream().filter(v->v.path("page").asInt()==k.path("page").asInt(1)).findFirst().orElse(null);String value="";
            if(p!=null) { JsonNode field=items(p.path("fields")).stream().filter(f->f.path("name").asText().equals(k.path("name").asText())).findFirst().orElse(null);value=engineFields&&!k.path("searchType").asText().isEmpty()&&field!=null?field.path("text").asText():select(k,p); }
            ArrayNode errors=validate(k,value);if(!errors.isEmpty()&&(k.path("verify").asBoolean()||k.path("required").asBoolean())) needs=true;
            values.set(k.path("name").asText(),obj("value",value,"valid",errors.isEmpty(),"errors",errors,"verify",k.path("verify").asBoolean()));
        }
        for(JsonNode g:items(template.path("groups"))) { ObjectNode data=group(g,ocr);groups.set(g.path("name").asText(),data);for(JsonNode r:items(data.path("rows"))) for(String name:names(r.path("values"))) if(!r.path("values").path(name).path("valid").asBoolean()) needs=true; }
        result.setAll(obj("classified",true,"templateId",template.get("id"),"templateVersion",template.path("version").asInt(1),"docType",template.path("docType"),"values",values,"groups",groups,"needsReview",needs));return result;
    }
    static ObjectNode view(JsonNode normalized) {
        ObjectNode result=normalized.deepCopy();for(JsonNode p:result.path("pages")) for(JsonNode w:p.path("words")) ((ObjectNode)w).remove(List.of("cx","cy","h"));return result;
    }
}
