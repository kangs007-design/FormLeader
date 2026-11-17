package com.textsense.product;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import javax.imageio.*;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class DocumentsTest {
    @TempDir Path directory;
    @Test void splitClonesInheritedFontsCropAndRotationWithoutClosedSourceStreams() throws Exception {
        Path source=directory.resolve("original.pdf");
        try(PDDocument doc=new PDDocument();var fontStream=getClass().getResourceAsStream("/fonts/Pretendard-Regular.ttf")) {
            var font=PDType0Font.load(doc,fontStream,false);PDPage page=new PDPage(new PDRectangle(500,700));page.setCropBox(new PDRectangle(20,30,450,620));page.setRotation(90);doc.addPage(page);
            try(PDPageContentStream stream=new PDPageContentStream(doc,page)) { stream.setNonStrokingColor(java.awt.Color.BLUE);stream.addRect(40,80,200,100);stream.fill();stream.beginText();stream.setFont(font,16);stream.newLineAtOffset(70,400);stream.showText("한글 검증 A-2026-777");stream.endText(); }
            doc.getDocumentCatalog().getPages().getCOSObject().setItem(COSName.RESOURCES,page.getResources().getCOSObject());page.getCOSObject().removeItem(COSName.RESOURCES);doc.addPage(new PDPage());doc.save(source.toFile());
        }
        byte[] split=Documents.split(source,List.of(1));
        try(PDDocument original=Loader.loadPDF(source.toFile());PDDocument child=Loader.loadPDF(split)) {
            assertEquals(1,child.getNumberOfPages());assertEquals(90,child.getPage(0).getRotation());assertEquals(original.getPage(0).getCropBox().getWidth(),child.getPage(0).getCropBox().getWidth());
            String originalText=new PDFTextStripper().getText(original).trim(),childText=new PDFTextStripper().getText(child).trim();
            assertEquals(originalText,childText);assertTrue(childText.replaceAll("\\s+","").contains("한글검증A-2026-777"),childText);
            BufferedImage a=new PDFRenderer(original).renderImage(0),b=new PDFRenderer(child).renderImage(0);assertEquals(a.getWidth(),b.getWidth());assertEquals(a.getHeight(),b.getHeight());assertArrayEquals(a.getRGB(0,0,a.getWidth(),a.getHeight(),null,0,a.getWidth()),b.getRGB(0,0,b.getWidth(),b.getHeight(),null,0,b.getWidth()));
        }
        var sizes=Documents.geometry(source,2);assertEquals(1240,sizes.get(0).path("width").asDouble());assertEquals(900,sizes.get(0).path("height").asDouble());
    }
    @Test void multipleTiffPagesBecomePhysicalPdfPagesAndPngPreviews() throws Exception {
        Path image=directory.resolve("multi.tiff");var writer=ImageIO.getImageWritersByFormatName("TIFF").next();
        try(var output=ImageIO.createImageOutputStream(image.toFile())) { writer.setOutput(output);writer.prepareWriteSequence(null);for(int i=0;i<2;i++){BufferedImage page=new BufferedImage(100,140,BufferedImage.TYPE_INT_RGB);var g=page.createGraphics();g.setColor(i==0?java.awt.Color.RED:java.awt.Color.GREEN);g.fillRect(0,0,100,140);g.dispose();writer.writeToSequence(new IIOImage(page,null,null),null);}writer.endWriteSequence(); }finally {writer.dispose();}
        assertEquals(2,Documents.geometry(image,2).size());assertEquals(100,Documents.image(image,2).getWidth());assertTrue(Documents.png(image,1).length>0);
        try(PDDocument pdf=Loader.loadPDF(Documents.split(image,List.of(2,1)))) { assertEquals(2,pdf.getNumberOfPages()); }
        assertThrows(ApiError.class,()->Documents.image(image,3));
    }
    @Test void csvCellsDoNotExecuteFormulas() {
        for(String value:List.of("=SUM(A1:A2)"," +1","@command","-1","\tvalue")) assertTrue(Exports.csv(value).startsWith("\"'"));
        assertEquals("\"한글 \"\"인용\"\"\"",Exports.csv("한글 \"인용\""));
        String longText="가".repeat(32766)+"😀"+"나".repeat(20000);var chunks=Exports.cellChunks(longText);assertEquals(longText,String.join("",chunks));assertTrue(chunks.stream().allMatch(c->c.length()<=32767&&!Character.isHighSurrogate(c.charAt(c.length()-1))));
    }
}
