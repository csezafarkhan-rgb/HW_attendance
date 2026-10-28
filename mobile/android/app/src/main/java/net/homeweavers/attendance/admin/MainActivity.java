package net.homeweavers.attendance.admin;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(AdminPrintPlugin.class);
        super.onCreate(state);
        // Employee and payroll data must not enter Android's recent-app preview.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        CookieManager.getInstance().setAcceptCookie(true);
        getBridge().getWebView().getSettings().setAllowFileAccess(false);
        getBridge().getWebView().getSettings().setAllowContentAccess(true);
    }
    @Override public void onStop() {
        CookieManager.getInstance().flush();
        super.onStop();
    }
}
