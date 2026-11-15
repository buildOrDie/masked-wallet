package com.maskedwallet.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Updates MASKED from inside the app (it isn't on Google Play). Downloads the new APK from MASKED's own site only,
 * checks its SHA-256 against the one the site published (android.json), and opens Android's "update this app?"
 * screen. Android itself then refuses anything not signed with the same key as the installed app.
 */
@CapacitorPlugin(name = "MaskedUpdater")
public class UpdaterPlugin extends Plugin {
    private static final String HOST = "signet.maskedwallet.com";
    private static final long MAX_BYTES = 200L * 1024 * 1024;

    /** Whether Android lets MASKED open the installer (a one-time "allow from this source" switch). */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        boolean ok = Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls();
        r.put("allowed", ok);
        call.resolve(r);
    }

    /** Opens Android's "Install unknown apps" switch for MASKED. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 26) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    /** Download the APK at `url` (MASKED's site only), check `sha256`, open the installer. Progress: "progress" events. */
    @PluginMethod
    public void install(PluginCall call) {
        final String url = call.getString("url", "");
        final String expected = call.getString("sha256", "").toLowerCase();
        if (!expected.matches("[0-9a-f]{64}")) { call.reject("The update has no checksum to check it against."); return; }
        final URL u;
        try { u = new URL(url); } catch (Exception e) { call.reject("Not a valid update address."); return; }
        if (!"https".equals(u.getProtocol()) || !HOST.equals(u.getHost())) { call.reject("Updates only come from " + HOST + "."); return; }
        // Android 6's installer can't open the app's own files: those phones update from the install page
        if (Build.VERSION.SDK_INT < 24) { call.reject("old-android"); return; }

        getBridge().execute(() -> {
            File dir = new File(getContext().getCacheDir(), "updates");
            File apk = new File(dir, "masked-update.apk");
            HttpURLConnection c = null;
            try {
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("Can't save the update.");
                if (apk.exists() && !apk.delete()) throw new Exception("Can't replace an earlier download.");
                c = (HttpURLConnection) u.openConnection();
                c.setConnectTimeout(20000);
                c.setReadTimeout(60000);
                c.setInstanceFollowRedirects(false);
                int code = c.getResponseCode();
                if (code != 200) throw new Exception("The site answered " + code + ".");
                long total = c.getContentLength(); // getContentLengthLong needs Android 7
                if (total > MAX_BYTES) throw new Exception("The update is larger than expected.");
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                long loaded = 0, told = 0;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        md.update(buf, 0, n);
                        loaded += n;
                        if (loaded > MAX_BYTES) throw new Exception("The update is larger than expected.");
                        if (loaded - told >= 256 * 1024) {
                            told = loaded;
                            JSObject p = new JSObject();
                            p.put("loaded", loaded);
                            p.put("total", total);
                            notifyListeners("progress", p);
                        }
                    }
                }
                StringBuilder hex = new StringBuilder();
                for (byte b : md.digest()) hex.append(String.format("%02x", b));
                if (!hex.toString().equals(expected)) {
                    apk.delete();
                    throw new Exception("The download doesn't match the published checksum, so it wasn't installed.");
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                JSObject r = new JSObject();
                r.put("started", true);
                call.resolve(r);
            } catch (Exception e) {
                if (apk.exists()) apk.delete();
                call.reject(e.getMessage() != null ? e.getMessage() : "The update didn't download.");
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }
}
