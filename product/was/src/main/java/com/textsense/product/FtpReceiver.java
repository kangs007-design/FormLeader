package com.textsense.product;

import org.apache.ftpserver.*;
import org.apache.ftpserver.ftplet.*;
import org.apache.ftpserver.listener.ListenerFactory;
import org.apache.ftpserver.usermanager.UsernamePasswordAuthentication;
import org.apache.ftpserver.usermanager.impl.*;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** Passive, upload-only receiver. Only names registered by active OCR jobs are writable. */
final class FtpReceiver implements AutoCloseable {
    private final Set<String> expected=ConcurrentHashMap.newKeySet();
    private final FtpServer server;
    void expect(String name) { expected.add(name); }
    void forget(String name) { expected.remove(name); }
    FtpReceiver(RuntimeConfig config) throws Exception {
        if(!config.ftpEnabled) { server=null;return; }
        FtpServerFactory factory=new FtpServerFactory();ListenerFactory listener=new ListenerFactory();listener.setServerAddress(config.ftpBind);listener.setPort(config.ftpPort);
        DataConnectionConfigurationFactory data=new DataConnectionConfigurationFactory();data.setActiveEnabled(false);data.setPassiveAddress(config.ftpBind);data.setPassiveExternalAddress(config.ftpPublicHost());data.setPassivePorts(config.pasvMin+"-"+config.pasvMax);data.setPassiveIpCheck(true);data.setIdleTime(60);listener.setDataConnectionConfiguration(data.createDataConnectionConfiguration());factory.addListener("default",listener.createListener());
        BaseUser user=new BaseUser();user.setName(config.ftpUser);user.setHomeDirectory(config.output.toString());user.setMaxIdleTime(60);user.setAuthorities(List.of(new WritePermission(),new ConcurrentLoginPermission(8,8),new TransferRatePermission(0,0)));
        factory.setUserManager(new UserManager() {
            public User getUserByName(String name) { return config.ftpUser.equals(name)?user:null; }
            public String[] getAllUserNames() { return new String[]{config.ftpUser}; }
            public void delete(String name) throws FtpException { throw new FtpException("Immutable runtime user"); }
            public void save(User value) throws FtpException { throw new FtpException("Immutable runtime user"); }
            public boolean doesExist(String name) { return config.ftpUser.equals(name); }
            public String getAdminName() { return ""; }
            public boolean isAdmin(String name) { return false; }
            public User authenticate(Authentication a) throws AuthenticationFailedException {
                if(a instanceof UsernamePasswordAuthentication p&&config.ftpUser.equals(p.getUsername())&&Passwords.equal(config.ftpPassword,p.getPassword())) return user;
                throw new AuthenticationFailedException("Invalid credentials");
            }
        });
        factory.setFtplets(Map.of("uploads",new DefaultFtplet() {
            @Override public FtpletResult beforeCommand(FtpSession session,FtpRequest request) throws FtpException,IOException {
                String command=request.getCommand().toUpperCase(Locale.ROOT),name=Optional.ofNullable(request.getArgument()).orElse("");
                String fileName=name.startsWith("/")?name.substring(1):name;
                if(RuntimeConfig.env("FTP_TRACE","false").equals("true")) System.getLogger("formreader.ftp").log(System.Logger.Level.INFO,"FTP "+command+(Set.of("STOR","APPE","CWD","MKD","SIZE").contains(command)?" "+name.replaceAll("[\\p{Cntrl}]",""):""));
                boolean allowed=Set.of("USER","PASS","FEAT","OPTS","TYPE","MODE","STRU","SYST","PWD","XPWD","EPSV","PASV","NOOP","QUIT","ABOR","ALLO").contains(command)
                    ||command.equals("CWD")&&Set.of("/",".").contains(name)
                    ||Set.of("STOR","APPE","SIZE").contains(command)&&session.isLoggedIn()&&fileName.matches("job_[A-Za-z0-9_-]+\\.json")&&expected.contains(fileName);
                if(!allowed) { session.write(new DefaultFtpReply(550,"Upload-only receiver: operation not allowed"));return FtpletResult.SKIP; }
                return FtpletResult.DEFAULT;
            }
            @Override public FtpletResult onUploadEnd(FtpSession session,FtpRequest request) throws IOException {
                String name=request.getArgument();Path file=Documents.managed(config.output,name.startsWith("/")?name.substring(1):name);if(Files.size(file)>64L*1024*1024) { Files.deleteIfExists(file);return FtpletResult.DISCONNECT; }return FtpletResult.DEFAULT;
            }
            @Override public FtpletResult onAppendEnd(FtpSession session,FtpRequest request) throws IOException { return onUploadEnd(session,request); }
        }));
        server=factory.createServer();server.start();
    }
    @Override public void close() { if(server!=null) server.stop(); }
}
