package net.homeweavers.attendance.admin;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AdminPrint")
public class AdminPrintPlugin extends Plugin {
    private WebView printView;
    @PluginMethod public void print(PluginCall call) {
        String html = call.getString("html", "");
        if (html.isEmpty()) { call.reject("Nothing to print"); return; }
        getActivity().runOnUiThread(() -> {
            if (printView != null) { printView.destroy(); }
            printView = new WebView(getContext());
            printView.getSettings().setJavaScriptEnabled(false);
            printView.getSettings().setAllowFileAccess(false);
            printView.getSettings().setBlockNetworkLoads(true);
            printView.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView view, String url) {
                    PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                    String title = call.getString("title", "Attendance document");
                    manager.print(title, view.createPrintDocumentAdapter(title),
                        new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
                    call.resolve(new JSObject());
                }
                @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return true; }
            });
            printView.loadDataWithBaseURL("https://localhost/", html, "text/html", "UTF-8", null);
        });
    }
    @Override protected void handleOnDestroy() {
        if (printView != null) { printView.destroy(); printView = null; }
    }
}
