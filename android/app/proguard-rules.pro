# PingPong WebView wrapper rules.
# The website JavaScript is remote and is not processed by R8.
# Keep Android framework callback signatures used by WebView.
-keepclassmembers class * extends android.webkit.WebChromeClient {
    <methods>;
}
-keepclassmembers class * extends android.webkit.WebViewClient {
    <methods>;
}

# Keep the trusted WebView JavaScript bridge used by the remote Ping Pong app.
-keepclassmembers class com.pingpong.voice.MainActivity$WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.pingpong.voice.VoiceForegroundService { *; }
-keep class com.pingpong.voice.PingPongApplication { *; }
