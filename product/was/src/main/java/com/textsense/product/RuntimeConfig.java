package com.textsense.product;

import java.net.*;
import java.nio.file.*;
import java.util.*;

final class RuntimeConfig {
    final Path data,input,output;
    final String gateway,engine,taskName,inputUri,outputUri,publicUrl,cancelPath;
    final int requestTimeout,jobTimeout,poll,outputWait,inputPort;
    final double pdfScale;
    final boolean ftpEnabled,mock;
    final String ftpHost,ftpUser,ftpPassword,ftpBind;
    final int ftpPort,pasvMin,pasvMax;
    RuntimeConfig() throws Exception {
        data=Paths.get(env("FORMREADER_DATA_DIR",Paths.get(System.getProperty("catalina.base","."),"formreader-data").toString())).toAbsolutePath().normalize();
        input=Paths.get(env("LOCAL_INPUT_DIR",data.resolve("input").toString())).toAbsolutePath().normalize();output=Paths.get(env("LOCAL_OUTPUT_DIR",data.resolve("output").toString())).toAbsolutePath().normalize();
        Files.createDirectories(data);Files.createDirectories(input);Files.createDirectories(output);
        gateway=env("TEXTSENSE_BASE_URL","http://"+env("TEXTSENSE_HOST","192.168.0.25")+":"+env("TEXTSENSE_PORT","7777")).replaceAll("/+$","");
        engine=env("TEXTSENSE_ENGINE_URL","http://textsense:8080");taskName=env("TEXTSENSE_TASK_NAME","formreader-product");
        publicUrl=env("FORMREADER_INPUT_PUBLIC_URL","").replaceAll("/+$","");
        inputPort=integer("FORMREADER_INPUT_PORT",0,0,65535);
        inputUri=env("EPAPYRUS_INPUT_URI","file:///ePapyrus/data/input").replaceAll("/+$","");outputUri=env("EPAPYRUS_OUTPUT_URI","file:///ePapyrus/data/output").replaceAll("/+$","");
        requestTimeout=integer("REQUEST_TIMEOUT_MS",15000,100,120000);jobTimeout=integer("JOB_TIMEOUT_MS",120000,500,3_600_000);poll=integer("JOB_POLL_INTERVAL_MS",1000,10,60000);outputWait=integer("OUTPUT_FILE_WAIT_MS",30000,100,300000);
        pdfScale=Double.parseDouble(env("PDF_OCR_SCALE","2"));if(!Double.isFinite(pdfScale)||pdfScale<=0||pdfScale>10) throw new IllegalArgumentException("PDF_OCR_SCALE");
        ftpEnabled=env("FTP_ENABLED","false").equalsIgnoreCase("true");ftpHost=env("FTP_PUBLIC_HOST","auto");ftpUser=env("FTP_USER","formreader");ftpPassword=env("FTP_PASSWORD",Passwords.token());ftpBind=env("FTP_BIND_ADDRESS","127.0.0.1");
        ftpPort=integer("FTP_PORT",2121,1024,65535);pasvMin=integer("FTP_PASV_MIN",50000,1024,65535);pasvMax=integer("FTP_PASV_MAX",50020,pasvMin,65535);
        cancelPath=env("TEXTSENSE_CANCEL_PATH","");mock=env("FORMREADER_MOCK_MODE","0").equals("1");
        URI uri=URI.create(gateway);if(!Set.of("http","https").contains(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null) throw new IllegalArgumentException("TEXTSENSE_BASE_URL");
    }
    static String env(String name,String fallback) { String v=System.getenv(name);return v==null||v.isBlank()?fallback:v; }
    static int integer(String name,int fallback,int min,int max) { int n=Integer.parseInt(env(name,""+fallback));if(n<min||n>max) throw new IllegalArgumentException(name);return n; }
    String localHost() throws Exception { URI uri=URI.create(gateway);try(DatagramSocket socket=new DatagramSocket()) { socket.connect(InetAddress.getByName(uri.getHost()),uri.getPort()>0?uri.getPort():80);return socket.getLocalAddress().getHostAddress(); } }
    String ftpPublicHost() throws Exception { return ftpHost.equals("auto")?localHost():ftpHost; }
}
