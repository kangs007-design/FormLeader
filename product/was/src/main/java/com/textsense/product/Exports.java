package com.textsense.product;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.graphics.state.RenderingMode;
import org.apache.pdfbox.pdmodel.common.filespecification.*;
import org.apache.pdfbox.util.Matrix;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.stream.Collectors;
import static com.textsense.product.Nodes.*;

final class Exports {
    final Jobs jobs;
    record Result(byte[] bytes,String type,String name) {}
    Exports(Jobs jobs) { this.jobs=jobs; }
    ObjectNode data(String id) throws Exception {
        ObjectNode job=jobs.get(id);Jobs.done(job);ObjectNode view=jobs.view(id);JsonNode review=job.path("review"),ocr=job.path("ocrResult");
        return obj("job",job,"view",view,"fileName",job.path("fileName"),"values",review.path("values").isObject()?review.path("values"):ocr.path("values"),"groups",review.path("groups").isObject()?review.path("groups"):ocr.path("groups"),"text",review.has("text")?review.path("text").asText():items(view.path("pages")).stream().map(p->p.path("content").asText()).collect(Collectors.joining("\n\n")),"review",review.isObject()?review:null);
    }
    static String xml(String s) { return s.replaceAll("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]","").replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\"","&quot;").replace("'","&apos;"); }
    static String md(String s) { return s.replace("|","\\|").replaceAll("\\r?\\n","<br>"); }
    static String csv(String s) { return "\""+(s.matches("(?s)^\\s*[=+@-].*")||s.matches("(?s)^[\\t\\r\\n].*")?"'":"")+s.replace("\"","\"\"")+"\""; }
    static List<List<String>> rows(ObjectNode d) {
        List<List<String>> rows=new ArrayList<>();rows.add(List.of("문서","그룹","행","항목","값"));String file=d.path("fileName").asText();
        for(String name:names(d.path("values"))) rows.add(List.of(file,"","",name,d.path("values").path(name).path("value").asText()));
        for(String name:names(d.path("groups"))) { int i=0;for(JsonNode row:items(d.path("groups").path(name).path("rows"))) { i++;for(String key:names(row.path("values"))) rows.add(List.of(file,name,""+i,key,row.path("values").path(key).path("value").asText())); } }
        if(rows.size()==1) rows.add(List.of(file,"","","본문",d.path("text").asText()));return rows;
    }
    Result export(String id,String format) throws Exception {
        ObjectNode d=data(id);String file=d.path("fileName").asText(),stem=file.replaceFirst("\\.[^.]+$","");
        ObjectNode result=obj("fileName",d.path("fileName"),"templateId",d.path("job").path("ocrResult").path("templateId"),"templateVersion",d.path("job").path("ocrResult").path("templateVersion"),"values",d.path("values"),"groups",d.path("groups"),"text",d.path("text"),"pages",d.path("view").path("pages"),"review",d.path("review"));
        byte[] bytes;String type;
        switch(format) {
            case "json"->{ bytes=Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsBytes(result);type="application/json"; }
            case "txt"->{ bytes=d.path("text").asText().getBytes(StandardCharsets.UTF_8);type="text/plain;charset=UTF-8"; }
            case "csv"->{ bytes=("\uFEFF"+rows(d).stream().map(row->row.stream().map(Exports::csv).collect(Collectors.joining(","))).collect(Collectors.joining("\r\n"))).getBytes(StandardCharsets.UTF_8);type="text/csv;charset=UTF-8"; }
            case "xml"->{ StringBuilder s=new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<document name=\"").append(xml(file)).append("\"><fields>");
                for(String name:names(d.path("values"))) { JsonNode v=d.path("values").path(name);s.append("<field name=\"").append(xml(name)).append("\" valid=\"").append(v.path("valid").asBoolean()).append("\">").append(xml(v.path("value").asText())).append("</field>"); }
                s.append("</fields><groups>");for(String name:names(d.path("groups"))) { s.append("<group name=\"").append(xml(name)).append("\">");int index=0;for(JsonNode row:items(d.path("groups").path(name).path("rows"))) { s.append("<row index=\"").append(++index).append("\" page=\"").append(row.path("page").asInt()).append("\">");for(String key:names(row.path("values"))) s.append("<field name=\"").append(xml(key)).append("\">").append(xml(row.path("values").path(key).path("value").asText())).append("</field>");s.append("</row>"); }s.append("</group>"); }
                bytes=s.append("</groups><text>").append(xml(d.path("text").asText())).append("</text></document>").toString().getBytes(StandardCharsets.UTF_8);type="application/xml;charset=UTF-8";
            }
            case "md"->{ StringBuilder s=new StringBuilder("# ").append(file.replaceAll("[\\r\\n#]"," ")).append("\n\n");
                if(!d.path("values").isEmpty()) { s.append("| 항목 | 값 |\n| --- | --- |\n");for(String name:names(d.path("values"))) s.append("| ").append(md(name)).append(" | ").append(md(d.path("values").path(name).path("value").asText())).append(" |\n");s.append('\n'); }
                for(String name:names(d.path("groups"))) { JsonNode group=d.path("groups").path(name);List<String> columns=items(group.path("columns")).stream().map(JsonNode::asText).toList();s.append("## ").append(md(name)).append("\n\n| ").append(columns.stream().map(Exports::md).collect(Collectors.joining(" | "))).append(" |\n| ").append(columns.stream().map(c->"---").collect(Collectors.joining(" | "))).append(" |\n");for(JsonNode row:items(group.path("rows"))) s.append("| ").append(columns.stream().map(c->md(row.path("values").path(c).path("value").asText())).collect(Collectors.joining(" | "))).append(" |\n");s.append('\n'); }
                if(d.path("review").has("text")) s.append(d.path("text").asText());else for(JsonNode p:items(d.path("view").path("pages"))) { s.append("## ").append(p.path("page").asInt()).append(" 페이지\n\n").append(p.path("content").asText()).append("\n\n");for(JsonNode table:items(p.path("tables"))) { int r=0;for(JsonNode row:items(table.path("grid"))) { s.append("| ").append(items(row).stream().map(c->md(c.asText())).collect(Collectors.joining(" | "))).append(" |\n");if(r++==0) s.append("| ").append(items(row).stream().map(c->"---").collect(Collectors.joining(" | "))).append(" |\n"); }s.append('\n'); } }
                bytes=s.toString().getBytes(StandardCharsets.UTF_8);type="text/markdown;charset=UTF-8";
            }
            case "xlsx"->{ bytes=xlsx(d);type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
            case "pdf"->{ bytes=pdf(d);type="application/pdf"; }
            default->throw ApiError.bad("지원하는 형식: json, xml, txt, csv, xlsx, pdf, md");
        }
        return new Result(bytes,type,stem+"."+format);
    }
    static void row(Sheet sheet,List<String> values) {
        List<List<String>> chunks=values.stream().map(Exports::cellChunks).toList();int parts=chunks.stream().mapToInt(List::size).max().orElse(1);
        for(int part=0;part<parts;part++) { if(sheet.getLastRowNum()>=1_048_574) throw ApiError.bad("Excel 행 제한을 초과했습니다. 문서를 분리하세요.");Row r=sheet.createRow(sheet.getPhysicalNumberOfRows());for(int i=0;i<values.size();i++) { List<String> cells=chunks.get(i);r.createCell(i,CellType.STRING).setCellValue(part<cells.size()?cells.get(part):""); } }
    }
    static List<String> cellChunks(String value) {
        List<String> chunks=new ArrayList<>();for(int start=0;start<value.length();) { int end=Math.min(start+32767,value.length());if(end<value.length()&&Character.isHighSurrogate(value.charAt(end-1))&&Character.isLowSurrogate(value.charAt(end))) end--;chunks.add(value.substring(start,end));start=end; }return chunks.isEmpty()?List.of(""):chunks;
    }
    static byte[] xlsx(ObjectNode d) throws Exception {
        try(XSSFWorkbook book=new XSSFWorkbook();ByteArrayOutputStream bytes=new ByteArrayOutputStream()) {
            Sheet fields=book.createSheet("추출 항목");row(fields,List.of("항목","값","검증","검수"));
            for(String name:names(d.path("values"))) { JsonNode v=d.path("values").path(name);row(fields,List.of(name,v.path("value").asText(),v.path("valid").asBoolean()?"정상":items(v.path("errors")).stream().map(JsonNode::asText).collect(Collectors.joining(", ")),d.path("review").path("confirmed").asBoolean()?"완료":"미확정")); }
            for(String name:names(d.path("groups"))) { JsonNode group=d.path("groups").path(name);Sheet s=book.createSheet(org.apache.poi.ss.util.WorkbookUtil.createSafeSheetName("반복"+book.getNumberOfSheets()+"_"+name));List<String> cols=items(group.path("columns")).stream().map(JsonNode::asText).toList();List<String> header=new ArrayList<>(List.of("페이지"));header.addAll(cols);row(s,header);for(JsonNode r:items(group.path("rows"))) { List<String> values=new ArrayList<>(List.of(r.path("page").asText()));for(String c:cols) values.add(r.path("values").path(c).path("value").asText());row(s,values); } }
            Sheet body=book.createSheet("본문");row(body,List.of("페이지","본문"));if(d.path("review").has("text")) row(body,List.of("검수 본문",d.path("text").asText()));else for(JsonNode p:items(d.path("view").path("pages"))) row(body,List.of(p.path("page").asText(),p.path("content").asText()));
            for(JsonNode p:items(d.path("view").path("pages"))) { int i=0;for(JsonNode table:items(p.path("tables"))) { Sheet s=book.createSheet("표_"+p.path("page").asInt()+"_"+(++i));for(JsonNode r:items(table.path("grid"))) row(s,items(r).stream().map(JsonNode::asText).toList()); } }
            CellStyle normal=book.createCellStyle();normal.setWrapText(true);normal.setVerticalAlignment(VerticalAlignment.TOP);CellStyle header=book.createCellStyle();header.cloneStyleFrom(normal);Font font=book.createFont();font.setBold(true);header.setFont(font);
            for(Sheet sheet:book) { sheet.createFreezePane(0,1);for(Row r:sheet) for(Cell c:r) c.setCellStyle(r.getRowNum()==0?header:normal);int count=sheet.getRow(0)==null?0:sheet.getRow(0).getLastCellNum();for(int i=0;i<count;i++) sheet.setColumnWidth(i,(i==0?26:46)*256); }
            book.write(bytes);return bytes.toByteArray();
        }
    }
    byte[] pdf(ObjectNode d) throws Exception {
        List<JsonNode> pages=items(d.path("view").path("pages"));int sourcePages=d.path("job").path("pageSizes").size();
        try(PDDocument pdf=Documents.pdf(jobs.source(d.path("job")),sourcePages);InputStream fontStream=Exports.class.getResourceAsStream("/fonts/Pretendard-Regular.ttf");ByteArrayOutputStream bytes=new ByteArrayOutputStream()) {
            if(fontStream==null) throw new IllegalStateException("Bundled Korean font missing");PDType0Font font=PDType0Font.load(pdf,fontStream,false);
            for(JsonNode o:pages) {
                int index=o.path("page").asInt()-1;if(index<0||index>=pdf.getNumberOfPages()) throw ApiError.bad("원본 PDF와 OCR 페이지가 일치하지 않습니다.");PDPage p=pdf.getPage(index);var b=p.getCropBox();int angle=Math.floorMod(p.getRotation(),360);float W=angle%180==0?b.getWidth():b.getHeight(),H=angle%180==0?b.getHeight():b.getWidth();
                try(PDPageContentStream stream=new PDPageContentStream(pdf,p,PDPageContentStream.AppendMode.APPEND,true,true)) {
                    stream.setRenderingMode(RenderingMode.NEITHER);
                    for(JsonNode word:items(o.path("words"))) {
                        StringBuilder safe=new StringBuilder();for(int cp:word.path("text").asText().replaceAll("[\\r\\n\\t]"," ").codePoints().toArray()) { String c=new String(Character.toChars(cp));try { font.encode(c);safe.append(c); }catch(IllegalArgumentException e) { safe.append('?'); } }String text=safe.toString();if(text.isEmpty()) continue;
                        float u=(float)(word.path("x1").asDouble()/o.path("width").asDouble()*W),v=(float)(word.path("y2").asDouble()/o.path("height").asDouble()*H);
                        float x=angle==90?b.getLowerLeftX()+v:angle==180?b.getLowerLeftX()+b.getWidth()-u:angle==270?b.getLowerLeftX()+b.getWidth()-v:b.getLowerLeftX()+u;
                        float y=angle==90?b.getLowerLeftY()+u:angle==180?b.getLowerLeftY()+v:angle==270?b.getLowerLeftY()+b.getHeight()-u:b.getLowerLeftY()+b.getHeight()-v;
                        double height=Math.max(1,(word.path("y2").asDouble()-word.path("y1").asDouble())/o.path("height").asDouble()*H),width=Math.max(1,(word.path("x2").asDouble()-word.path("x1").asDouble())/o.path("width").asDouble()*W);float size=(float)Math.max(.5,Math.min(height*.9,width/Math.max(.01,font.getStringWidth(text)/1000)));
                        stream.beginText();stream.setFont(font,size);stream.setTextMatrix(Matrix.getRotateInstance(Math.toRadians(angle),x,y));stream.showText(text);stream.endText();
                    }
                }
            }
            byte[] attachment=Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsBytes(obj("values",d.path("values"),"groups",d.path("groups"),"review",d.path("review")));
            PDComplexFileSpecification spec=new PDComplexFileSpecification();spec.setFile("formreader-result.json");spec.setFileUnicode("formreader-result.json");PDEmbeddedFile embedded=new PDEmbeddedFile(pdf,new ByteArrayInputStream(attachment));embedded.setSubtype("application/json");embedded.setSize(attachment.length);spec.setEmbeddedFile(embedded);spec.setEmbeddedFileUnicode(embedded);
            PDEmbeddedFilesNameTreeNode tree=new PDEmbeddedFilesNameTreeNode();tree.setNames(Map.of("formreader-result.json",spec));PDDocumentNameDictionary names=new PDDocumentNameDictionary(pdf.getDocumentCatalog());names.setEmbeddedFiles(tree);pdf.getDocumentCatalog().setNames(names);pdf.save(bytes);return bytes.toByteArray();
        }
    }
}
