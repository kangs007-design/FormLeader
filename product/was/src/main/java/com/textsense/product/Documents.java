package com.textsense.product;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.rendering.PDFRenderer;
import javax.imageio.*;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import static com.textsense.product.Nodes.*;

final class Documents {
    static final int MAX_BYTES=40*1024*1024;
    static final Set<String> EXTENSIONS=Set.of("pdf","png","jpg","jpeg","bmp","tif","tiff");
    static String name(String name) {
        if(name==null||name.isBlank()||name.length()>254) throw ApiError.bad("파일 이름을 확인하세요.");
        return name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]","_");
    }
    static String extension(String name) { int i=name.lastIndexOf('.');return i<0?"":name.substring(i+1).toLowerCase(Locale.ROOT); }
    static byte[] decode(String encoded) {
        try { byte[] bytes=Base64.getDecoder().decode(encoded);if(bytes.length==0||bytes.length>MAX_BYTES) throw ApiError.bad("파일은 40MB 이내여야 합니다.");return bytes; }
        catch(IllegalArgumentException e) { throw ApiError.bad("파일의 Base64 형식이 올바르지 않습니다."); }
    }
    static Path managed(Path dir,String name) {
        if(name==null||!name.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9.]+")||name.contains("..")) throw ApiError.bad("관리 파일 경로가 올바르지 않습니다.");
        Path base=dir.toAbsolutePath().normalize(),target=base.resolve(name).normalize();
        if(!target.getParent().equals(base)||Files.isSymbolicLink(target)) throw ApiError.bad("관리 저장소 밖의 경로입니다.");
        return target;
    }
    static void atomic(Path path,byte[] bytes) throws IOException {
        Files.createDirectories(path.getParent());Path temp=Files.createTempFile(path.getParent(),".write-",".tmp");
        try { Files.write(temp,bytes);try { Files.move(temp,path,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING); }catch(AtomicMoveNotSupportedException e) { Files.move(temp,path,StandardCopyOption.REPLACE_EXISTING); } }
        finally { Files.deleteIfExists(temp); }
    }
    static ArrayNode geometry(Path file,double scale) throws Exception {
        ArrayNode result=arr();
        if(extension(file.toString()).equals("pdf")) {
            try(PDDocument pdf=Loader.loadPDF(file.toFile())) {
                if(pdf.getNumberOfPages()<1||pdf.getNumberOfPages()>10000) throw ApiError.bad("PDF 페이지 수를 확인하세요.");
                for(PDPage p:pdf.getPages()) { PDRectangle b=p.getCropBox();int rotation=Math.floorMod(p.getRotation(),360);boolean swap=rotation==90||rotation==270;result.add(obj("width",(swap?b.getHeight():b.getWidth())*scale,"height",(swap?b.getWidth():b.getHeight())*scale,"pdfScale",scale,"rotation",rotation,"source","pdf")); }
            }
        } else try(ImageInputStream stream=ImageIO.createImageInputStream(file.toFile())) {
            Iterator<ImageReader> readers=ImageIO.getImageReaders(stream);if(!readers.hasNext()) throw ApiError.bad("이미지 형식을 읽을 수 없습니다.");
            ImageReader reader=readers.next();try { reader.setInput(stream);int count=reader.getNumImages(true);if(count<1||count>10000) throw ApiError.bad("이미지 페이지 수를 확인하세요.");
                for(int i=0;i<count;i++) { int w=reader.getWidth(i),h=reader.getHeight(i);if(w<1||h<1||(long)w*h>80_000_000) throw ApiError.bad("이미지 픽셀 크기가 너무 큽니다.");result.add(obj("width",w,"height",h,"source","image")); }
            } finally { reader.dispose(); }
        }
        return result;
    }
    static BufferedImage image(Path file,int page) throws Exception {
        if(page<1||page>10000) throw ApiError.bad("페이지 번호를 확인하세요.");
        if(extension(file.toString()).equals("pdf")) try(PDDocument pdf=Loader.loadPDF(file.toFile())) {
            if(page>pdf.getNumberOfPages()) throw ApiError.bad("원본에 없는 페이지입니다.");
            PDRectangle box=pdf.getPage(page-1).getCropBox();if((double)box.getWidth()*box.getHeight()*4>80_000_000) throw ApiError.bad("페이지 크기가 너무 큽니다.");
            return new PDFRenderer(pdf).renderImageWithDPI(page-1,144);
        }
        try(ImageInputStream stream=ImageIO.createImageInputStream(file.toFile())) {
            Iterator<ImageReader> readers=ImageIO.getImageReaders(stream);if(!readers.hasNext()) throw ApiError.bad("이미지를 읽을 수 없습니다.");
            ImageReader reader=readers.next();try { reader.setInput(stream);if(page>reader.getNumImages(true)) throw ApiError.bad("원본에 없는 페이지입니다.");if((long)reader.getWidth(page-1)*reader.getHeight(page-1)>80_000_000) throw ApiError.bad("이미지 픽셀 크기가 너무 큽니다.");return reader.read(page-1); }finally { reader.dispose(); }
        }
    }
    static byte[] png(Path file,int page) throws Exception { ByteArrayOutputStream out=new ByteArrayOutputStream();ImageIO.write(image(file,page),"png",out);return out.toByteArray(); }
    static PDDocument pdf(Path file,int count) throws Exception {
        if(extension(file.toString()).equals("pdf")) return Loader.loadPDF(file.toFile());
        PDDocument out=new PDDocument();try { for(int i=1;i<=count;i++) { BufferedImage image=image(file,i);PDPage p=new PDPage(new PDRectangle(image.getWidth(),image.getHeight()));out.addPage(p);try(PDPageContentStream s=new PDPageContentStream(out,p)) { s.drawImage(LosslessFactory.createFromImage(out,image),0,0,image.getWidth(),image.getHeight()); } }return out; }
        catch(Exception e) { out.close();throw e; }
    }
    static byte[] split(Path file,List<Integer> pages) throws Exception {
        try(PDDocument out=new PDDocument()) {
            if(extension(file.toString()).equals("pdf")) try(PDDocument src=Loader.loadPDF(file.toFile())) {
                var clone=new org.apache.pdfbox.multipdf.PDFCloneUtility(out) {};
                for(int n:pages) {
                    if(n<1||n>src.getNumberOfPages()) throw ApiError.bad("원본에 없는 페이지입니다.");
                    PDPage original=src.getPage(n-1);var dictionary=new org.apache.pdfbox.cos.COSDictionary(original.getCOSObject());
                    dictionary.removeItem(org.apache.pdfbox.cos.COSName.PARENT);
                    if(original.getResources()!=null) dictionary.setItem(org.apache.pdfbox.cos.COSName.RESOURCES,original.getResources().getCOSObject());
                    dictionary.setItem(org.apache.pdfbox.cos.COSName.MEDIA_BOX,original.getMediaBox().getCOSArray());dictionary.setItem(org.apache.pdfbox.cos.COSName.CROP_BOX,original.getCropBox().getCOSArray());dictionary.setInt(org.apache.pdfbox.cos.COSName.ROTATE,original.getRotation());
                    out.addPage(new PDPage(clone.cloneForNewDocument(dictionary)));
                }
            }
            else for(int n:pages) { BufferedImage image=image(file,n);PDPage p=new PDPage(new PDRectangle(image.getWidth(),image.getHeight()));out.addPage(p);try(PDPageContentStream s=new PDPageContentStream(out,p)) { s.drawImage(LosslessFactory.createFromImage(out,image),0,0,image.getWidth(),image.getHeight()); } }
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();out.save(bytes);return bytes.toByteArray();
        }
    }
}
