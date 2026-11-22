package com.robot2027.companion;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.ActivityManager;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothSocket;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSuggestion;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.text.format.Formatter;
import android.view.View;
import android.view.WindowManager;
import android.widget.Toast;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "RobotNative")
public class RobotNativePlugin extends Plugin {

    public static volatile boolean sKioskLocked = false;
    public static volatile boolean sTempUnpinnedForWifi = false;

    private static final UUID ESP_SERVICE_UUID = UUID.fromString("4fafc201-1fb5-459e-8fcc-c5c9c331914b");
    private static final UUID ESP_CHAR_TX_UUID = UUID.fromString("beb5483e-36e1-4688-b7f5-ea07361b26a8");
    private static final UUID ESP_CHAR_RX_UUID = UUID.fromString("beb5483e-36e1-4688-b7f5-ea07361b26a9");
    private static final UUID CCCD_UUID        = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final UUID SPP_UUID         = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private TextToSpeech tts;
    private SpeechRecognizer speechRecognizer;
    private boolean isListening = false;
    private int savedNotifVol = -1;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService ioExecutor = Executors.newCachedThreadPool();

    // Bluetooth Dual-Mode (Classic + BLE) state
    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeScanner bleScanner;
    private ScanCallback bleScanCallback;
    private BroadcastReceiver btDiscoveryReceiver;
    private BroadcastReceiver btPairingReceiver;
    private boolean isBtScanning = false;
    private final ConcurrentHashMap<String, JSObject> discoveredBtDevices = new ConcurrentHashMap<>();

    private BluetoothGatt activeGatt;
    private BluetoothGattCharacteristic espTxChar;
    private BluetoothSocket activeRfcommSocket;
    private OutputStream rfcommOutStream;
    private String connectedBtAddress = "";
    private String connectedBtName = "";
    private String connectedBtMode = "";

    @Override
    public void load() {
        mainHandler.post(() -> {
            initTTS();
            applyKioskFlags(getActivity(), sKioskLocked);
        });
        try {
            BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
            if (bm != null) {
                bluetoothAdapter = bm.getAdapter();
            }
            if (bluetoothAdapter == null) {
                bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
            }
        } catch (Exception ignored) {}
    }

    public static void reapplyKioskIfLocked(Activity activity) {
        if (activity == null) return;
        if (sTempUnpinnedForWifi) return;
        applyKioskFlags(activity, sKioskLocked);
        if (sKioskLocked) {
            try {
                activity.startLockTask();
            } catch (Exception ignored) {}
        }
    }

    private void initTTS() {
        tts = new TextToSpeech(getContext(), status -> {
            if (status == TextToSpeech.SUCCESS) {
                tts.setLanguage(Locale.US);
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String utteranceId) {
                        JSObject data = new JSObject();
                        data.put("id", utteranceId);
                        notifyListeners("ttsStart", data);
                    }

                    @Override
                    public void onDone(String utteranceId) {
                        JSObject data = new JSObject();
                        data.put("id", utteranceId);
                        notifyListeners("ttsEnd", data);
                    }

                    @Override
                    public void onError(String utteranceId) {
                        JSObject data = new JSObject();
                        data.put("id", utteranceId);
                        notifyListeners("ttsEnd", data);
                    }
                });
            }
        });
    }

    public static void applyKioskFlags(Activity activity, boolean enable) {
        if (activity == null) return;
        activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        View decorView = activity.getWindow().getDecorView();

        if (enable) {
            decorView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
            );
            try {
                ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
                if (am != null && am.getLockTaskModeState() == ActivityManager.LOCK_TASK_MODE_NONE) {
                    activity.startLockTask();
                }
            } catch (Exception ignored) {}
        } else {
            try {
                activity.stopLockTask();
            } catch (Exception ignored) {}
            decorView.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    @PluginMethod
    public void requestAllPermissions(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        ArrayList<String> perms = new ArrayList<>();
        perms.add(Manifest.permission.CAMERA);
        perms.add(Manifest.permission.RECORD_AUDIO);
        perms.add(Manifest.permission.ACCESS_FINE_LOCATION);
        perms.add(Manifest.permission.ACCESS_COARSE_LOCATION);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            perms.add(Manifest.permission.BLUETOOTH_CONNECT);
            perms.add(Manifest.permission.BLUETOOTH_SCAN);
        } else {
            perms.add(Manifest.permission.BLUETOOTH);
            perms.add(Manifest.permission.BLUETOOTH_ADMIN);
        }

        ActivityCompat.requestPermissions(activity, perms.toArray(new String[0]), 2027);
        call.resolve();
    }

    @PluginMethod
    public void requestCameraPermission(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) {
            ActivityCompat.requestPermissions(activity, new String[]{
                Manifest.permission.CAMERA,
                Manifest.permission.RECORD_AUDIO
            }, 2028);
        }
        call.resolve();
    }

    private String resolveLocalIpv4(Context ctx, WifiManager wifiManager) {
        try {
            if (wifiManager != null) {
                WifiInfo info = wifiManager.getConnectionInfo();
                if (info != null && info.getIpAddress() != 0) {
                    String ip = Formatter.formatIpAddress(info.getIpAddress());
                    if (ip != null && !ip.equals("0.0.0.0")) return ip;
                }
            }
        } catch (Exception ignored) {}

        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Network net = cm.getActiveNetwork();
                if (net != null) {
                    LinkProperties lp = cm.getLinkProperties(net);
                    if (lp != null) {
                        for (LinkAddress la : lp.getLinkAddresses()) {
                            InetAddress addr = la.getAddress();
                            if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                                return addr.getHostAddress();
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {}

        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {}

        return "0.0.0.0";
    }

    @PluginMethod
    public void getDeviceStatus(PluginCall call) {
        Context ctx = getContext();
        IntentFilter ifilter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        Intent batteryStatus = ctx.registerReceiver(null, ifilter);

        int level = 100;
        float temp = 36.5f;
        boolean isCharging = false;

        if (batteryStatus != null) {
            int rawLevel = batteryStatus.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = batteryStatus.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (rawLevel >= 0 && scale > 0) {
                level = Math.round((rawLevel * 100f) / scale);
            }
            int rawTemp = batteryStatus.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 365);
            temp = rawTemp / 10.0f;
            int status = batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                         status == BatteryManager.BATTERY_STATUS_FULL;
        }

        String wifiSsid = "Chưa kết nối Wi-Fi";
        String localIp = "0.0.0.0";
        try {
            WifiManager wifiManager = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null && wifiManager.isWifiEnabled()) {
                localIp = resolveLocalIpv4(ctx, wifiManager);
                WifiInfo info = wifiManager.getConnectionInfo();
                if (info != null) {
                    String rawSsid = info.getSSID();
                    if (rawSsid != null) {
                        wifiSsid = rawSsid.replace("\"", "");
                    }
                    if (wifiSsid.isEmpty() || wifiSsid.contains("unknown ssid")) {
                        wifiSsid = !localIp.equals("0.0.0.0") ? "Đã kết nối Wi-Fi" : "Chưa kết nối Wi-Fi";
                    }
                }
            }
        } catch (Exception e) {
            wifiSsid = "Wi-Fi Sẵn sàng";
        }

        boolean isPinned = false;
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            if (am != null) {
                isPinned = am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE;
            }
        } catch (Exception ignored) {}

        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        int volumePct = 80;
        if (am != null) {
            int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            int cur = am.getStreamVolume(AudioManager.STREAM_MUSIC);
            if (max > 0) volumePct = Math.round((cur * 100f) / max);
        }

        JSObject ret = new JSObject();
        ret.put("battery", level);
        ret.put("temperature", temp);
        ret.put("isCharging", isCharging);
        ret.put("wifiSsid", wifiSsid);
        ret.put("localIp", localIp);
        ret.put("isPinned", isPinned);
        ret.put("kioskLocked", sKioskLocked);
        ret.put("volume", volumePct);
        ret.put("btConnected", !connectedBtAddress.isEmpty());
        ret.put("btName", connectedBtName);
        ret.put("btAddress", connectedBtAddress);
        call.resolve(ret);
    }

    // ==================== 1. DUAL-MODE BLUETOOTH SCAN & CONNECT (BLE + CLASSIC) ====================

    private boolean hasBtPermissions() {
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                && ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        }
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @SuppressLint("MissingPermission")
    private void upsertBtDevice(BluetoothDevice device, int rssi, String scanSource) {
        if (device == null) return;
        String addr = device.getAddress();
        if (addr == null || addr.isEmpty()) return;

        String rawName = null;
        try {
            rawName = device.getName();
        } catch (Exception ignored) {}

        boolean isPaired = false;
        try {
            isPaired = (device.getBondState() == BluetoothDevice.BOND_BONDED);
        } catch (Exception ignored) {}

        JSObject existing = discoveredBtDevices.get(addr);
        String finalName = (rawName != null && !rawName.trim().isEmpty())
            ? rawName.trim()
            : (existing != null ? existing.getString("name", "") : "");
        if (finalName.isEmpty()) {
            finalName = "Thiết bị Bluetooth (" + addr + ")";
        }

        String prevType = existing != null ? existing.getString("type", "") : "";
        String finalType = scanSource;
        if (!prevType.isEmpty() && !prevType.equals(scanSource)) {
            finalType = "Dual";
        }

        int finalRssi = (rssi != 0 && rssi != -127)
            ? rssi
            : (existing != null ? existing.getInteger("rssi", -65) : -65);

        JSObject item = new JSObject();
        item.put("address", addr);
        item.put("deviceId", addr);
        item.put("name", finalName);
        item.put("rssi", finalRssi);
        item.put("paired", isPaired);
        item.put("type", finalType);
        item.put("connected", addr.equalsIgnoreCase(connectedBtAddress));

        discoveredBtDevices.put(addr, item);
        notifyListeners("btDeviceFound", item);
    }

    @SuppressLint("MissingPermission")
    private void stopBtScanInternal() {
        isBtScanning = false;
        try {
            if (bleScanner != null && bleScanCallback != null) {
                bleScanner.stopScan(bleScanCallback);
            }
        } catch (Exception ignored) {}
        bleScanCallback = null;

        try {
            if (bluetoothAdapter != null && bluetoothAdapter.isDiscovering()) {
                bluetoothAdapter.cancelDiscovery();
            }
        } catch (Exception ignored) {}

        try {
            if (btDiscoveryReceiver != null) {
                getContext().unregisterReceiver(btDiscoveryReceiver);
            }
        } catch (Exception ignored) {}
        btDiscoveryReceiver = null;
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void scanBluetoothDevices(PluginCall call) {
        if (bluetoothAdapter == null) {
            call.reject("Thiết bị không hỗ trợ Bluetooth.");
            return;
        }
        if (!hasBtPermissions()) {
            requestAllPermissions(call);
            return;
        }
        if (!bluetoothAdapter.isEnabled()) {
            try {
                bluetoothAdapter.enable();
            } catch (Exception ignored) {}
            if (!bluetoothAdapter.isEnabled()) {
                call.reject("Bluetooth đang tắt. Hãy bật Bluetooth trên máy rồi thử lại.");
                return;
            }
        }

        stopBtScanInternal();
        discoveredBtDevices.clear();
        isBtScanning = true;

        try {
            Set<BluetoothDevice> bonded = bluetoothAdapter.getBondedDevices();
            if (bonded != null) {
                for (BluetoothDevice dev : bonded) {
                    upsertBtDevice(dev, -55, "Classic");
                }
            }
        } catch (Exception ignored) {}

        try {
            btDiscoveryReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    String action = intent.getAction();
                    if (BluetoothDevice.ACTION_FOUND.equals(action)) {
                        BluetoothDevice dev = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                        short rssi = intent.getShortExtra(BluetoothDevice.EXTRA_RSSI, (short) -65);
                        upsertBtDevice(dev, rssi, "Classic");
                    }
                }
            };
            IntentFilter filter = new IntentFilter();
            filter.addAction(BluetoothDevice.ACTION_FOUND);
            filter.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
            getContext().registerReceiver(btDiscoveryReceiver, filter);
            bluetoothAdapter.startDiscovery();
        } catch (Exception ignored) {}

        try {
            bleScanner = bluetoothAdapter.getBluetoothLeScanner();
            if (bleScanner != null) {
                bleScanCallback = new ScanCallback() {
                    @Override
                    public void onScanResult(int callbackType, ScanResult result) {
                        if (result != null && result.getDevice() != null) {
                            upsertBtDevice(result.getDevice(), result.getRssi(), "BLE");
                        }
                    }

                    @Override
                    public void onBatchScanResults(List<ScanResult> results) {
                        for (ScanResult r : results) {
                            if (r != null && r.getDevice() != null) {
                                upsertBtDevice(r.getDevice(), r.getRssi(), "BLE");
                            }
                        }
                    }
                };
                ScanSettings settings = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build();
                bleScanner.startScan(null, settings, bleScanCallback);
            }
        } catch (Exception ignored) {}

        mainHandler.postDelayed(() -> {
            if (!isBtScanning) return;
            stopBtScanInternal();
            JSArray arr = new JSArray();
            for (JSObject obj : discoveredBtDevices.values()) {
                arr.put(obj);
            }
            JSObject done = new JSObject();
            done.put("devices", arr);
            notifyListeners("btScanFinished", done);
        }, 10000);

        JSArray initialArr = new JSArray();
        for (JSObject obj : discoveredBtDevices.values()) {
            initialArr.put(obj);
        }
        JSObject ret = new JSObject();
        ret.put("scanning", true);
        ret.put("devices", initialArr);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopBluetoothScan(PluginCall call) {
        stopBtScanInternal();
        call.resolve();
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void connectBluetoothDevice(PluginCall call) {
        String address = call.getString("address", "");
        String name = call.getString("name", "Bluetooth Device");
        String pin = call.getString("pin", "");

        if (bluetoothAdapter == null || address.isEmpty()) {
            call.reject("Thiếu địa chỉ thiết bị Bluetooth.");
            return;
        }

        stopBtScanInternal();
        disconnectBtInternal();

        BluetoothDevice device;
        try {
            device = bluetoothAdapter.getRemoteDevice(address);
        } catch (Exception e) {
            call.reject("Địa chỉ Bluetooth không hợp lệ: " + e.getMessage());
            return;
        }

        if (!pin.isEmpty()) {
            try {
                if (btPairingReceiver != null) {
                    getContext().unregisterReceiver(btPairingReceiver);
                }
                btPairingReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        if (BluetoothDevice.ACTION_PAIRING_REQUEST.equals(intent.getAction())) {
                            BluetoothDevice dev = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                            if (dev != null && dev.getAddress().equalsIgnoreCase(address)) {
                                try {
                                    dev.setPin(pin.getBytes(StandardCharsets.UTF_8));
                                    abortBroadcast();
                                } catch (Exception ignored) {}
                            }
                        }
                    }
                };
                IntentFilter pf = new IntentFilter(BluetoothDevice.ACTION_PAIRING_REQUEST);
                pf.setPriority(IntentFilter.SYSTEM_HIGH_PRIORITY);
                getContext().registerReceiver(btPairingReceiver, pf);
            } catch (Exception ignored) {}
        }

        ioExecutor.execute(() -> {
            boolean rfcommConnected = false;
            try {
                if (device.getBondState() == BluetoothDevice.BOND_NONE) {
                    device.createBond();
                    Thread.sleep(1500);
                }
                BluetoothSocket sock = device.createRfcommSocketToServiceRecord(SPP_UUID);
                sock.connect();
                activeRfcommSocket = sock;
                rfcommOutStream = sock.getOutputStream();
                connectedBtAddress = address;
                connectedBtName = name;
                connectedBtMode = "SPP";
                rfcommConnected = true;

                InputStream in = sock.getInputStream();
                ioExecutor.execute(() -> {
                    byte[] buf = new byte[512];
                    StringBuilder sb = new StringBuilder();
                    try {
                        int n;
                        while (activeRfcommSocket != null && (n = in.read(buf)) > 0) {
                            sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                            int idx;
                            while ((idx = sb.indexOf("\n")) >= 0) {
                                String line = sb.substring(0, idx).trim();
                                sb.delete(0, idx + 1);
                                if (!line.isEmpty()) {
                                    JSObject ev = new JSObject();
                                    ev.put("data", line);
                                    notifyListeners("bleHardwareData", ev);
                                }
                            }
                        }
                    } catch (Exception ignored) {}
                });

                JSObject res = new JSObject();
                res.put("connected", true);
                res.put("mode", "SPP");
                res.put("address", address);
                res.put("name", name);
                call.resolve(res);
                return;
            } catch (Exception ignored) {}

            if (!rfcommConnected) {
                mainHandler.post(() -> {
                    try {
                        activeGatt = device.connectGatt(getContext(), false, new BluetoothGattCallback() {
                            @Override
                            public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                                if (newState == BluetoothProfile.STATE_CONNECTED) {
                                    connectedBtAddress = address;
                                    connectedBtName = name;
                                    connectedBtMode = "BLE";
                                    gatt.discoverServices();
                                    JSObject st = new JSObject();
                                    st.put("connected", true);
                                    st.put("address", address);
                                    st.put("name", name);
                                    notifyListeners("btConnectionChanged", st);
                                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                                    if (address.equalsIgnoreCase(connectedBtAddress)) {
                                        connectedBtAddress = "";
                                        connectedBtName = "";
                                        connectedBtMode = "";
                                        espTxChar = null;
                                    }
                                    JSObject st = new JSObject();
                                    st.put("connected", false);
                                    st.put("address", address);
                                    notifyListeners("btConnectionChanged", st);
                                }
                            }

                            @Override
                            public void onServicesDiscovered(BluetoothGatt gatt, int status) {
                                BluetoothGattService svc = gatt.getService(ESP_SERVICE_UUID);
                                if (svc != null) {
                                    espTxChar = svc.getCharacteristic(ESP_CHAR_TX_UUID);
                                    BluetoothGattCharacteristic rxChar = svc.getCharacteristic(ESP_CHAR_RX_UUID);
                                    if (rxChar != null) {
                                        gatt.setCharacteristicNotification(rxChar, true);
                                        BluetoothGattDescriptor desc = rxChar.getDescriptor(CCCD_UUID);
                                        if (desc != null) {
                                            desc.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                                            gatt.writeDescriptor(desc);
                                        }
                                    }
                                }
                            }

                            @Override
                            public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
                                byte[] val = characteristic.getValue();
                                if (val != null) {
                                    String msg = new String(val, StandardCharsets.UTF_8).trim();
                                    if (!msg.isEmpty()) {
                                        JSObject ev = new JSObject();
                                        ev.put("data", msg);
                                        notifyListeners("bleHardwareData", ev);
                                    }
                                }
                            }
                        }, BluetoothDevice.TRANSPORT_LE);

                        connectedBtAddress = address;
                        connectedBtName = name;
                        connectedBtMode = "BLE/Paired";
                        JSObject res = new JSObject();
                        res.put("connected", true);
                        res.put("mode", "BLE/Paired");
                        res.put("address", address);
                        res.put("name", name);
                        call.resolve(res);
                    } catch (Exception e) {
                        if (device.getBondState() == BluetoothDevice.BOND_BONDED || device.getBondState() == BluetoothDevice.BOND_BONDING) {
                            connectedBtAddress = address;
                            connectedBtName = name;
                            connectedBtMode = "Paired";
                            JSObject res = new JSObject();
                            res.put("connected", true);
                            res.put("mode", "Paired");
                            res.put("address", address);
                            res.put("name", name);
                            call.resolve(res);
                        } else {
                            call.reject("Không thể kết nối tới " + name + ": " + e.getMessage());
                        }
                    }
                });
            }
        });
    }

    @SuppressLint("MissingPermission")
    private void disconnectBtInternal() {
        try {
            if (activeRfcommSocket != null) {
                activeRfcommSocket.close();
            }
        } catch (Exception ignored) {}
        activeRfcommSocket = null;
        rfcommOutStream = null;

        try {
            if (activeGatt != null) {
                activeGatt.disconnect();
                activeGatt.close();
            }
        } catch (Exception ignored) {}
        activeGatt = null;
        espTxChar = null;
        connectedBtAddress = "";
        connectedBtName = "";
        connectedBtMode = "";
    }

    @PluginMethod
    public void disconnectBluetoothDevice(PluginCall call) {
        disconnectBtInternal();
        call.resolve();
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void sendBluetoothData(PluginCall call) {
        String cmd = call.getString("cmd", "");
        if (cmd.isEmpty()) {
            call.resolve();
            return;
        }
        byte[] bytes = (cmd + "\n").getBytes(StandardCharsets.UTF_8);
        try {
            if (rfcommOutStream != null) {
                rfcommOutStream.write(bytes);
                rfcommOutStream.flush();
            } else if (activeGatt != null && espTxChar != null) {
                espTxChar.setValue(bytes);
                activeGatt.writeCharacteristic(espTxChar);
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    // ==================== 2. WI-FI SCANNER & 100% IN-APP SUGGESTION CONNECT ====================

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void scanWifiNetworks(PluginCall call) {
        Context ctx = getContext();
        WifiManager wifiManager = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifiManager == null) {
            call.reject("Không truy cập được dịch vụ Wi-Fi.");
            return;
        }
        if (!wifiManager.isWifiEnabled()) {
            try {
                wifiManager.setWifiEnabled(true);
            } catch (Exception ignored) {}
        }

        try {
            wifiManager.startScan();
        } catch (Exception ignored) {}

        String currentSsid = "";
        try {
            WifiInfo info = wifiManager.getConnectionInfo();
            if (info != null && info.getSSID() != null) {
                currentSsid = info.getSSID().replace("\"", "");
            }
        } catch (Exception ignored) {}

        List<android.net.wifi.ScanResult> results = new ArrayList<>();
        try {
            List<android.net.wifi.ScanResult> raw = wifiManager.getScanResults();
            if (raw != null) results.addAll(raw);
        } catch (Exception ignored) {}

        Map<String, android.net.wifi.ScanResult> bestBySsid = new HashMap<>();
        for (android.net.wifi.ScanResult sr : results) {
            String ssid = (sr.SSID != null) ? sr.SSID.trim() : "";
            if (ssid.isEmpty()) continue;
            android.net.wifi.ScanResult prev = bestBySsid.get(ssid);
            if (prev == null || sr.level > prev.level) {
                bestBySsid.put(ssid, sr);
            }
        }

        List<android.net.wifi.ScanResult> uniqueList = new ArrayList<>(bestBySsid.values());
        Collections.sort(uniqueList, (a, b) -> Integer.compare(b.level, a.level));

        JSArray networks = new JSArray();
        for (android.net.wifi.ScanResult sr : uniqueList) {
            String ssid = sr.SSID.trim();
            String caps = sr.capabilities != null ? sr.capabilities : "";
            boolean secured = caps.contains("WPA") || caps.contains("WEP") || caps.contains("SAE") || caps.contains("EAP");
            String band = (sr.frequency >= 4900) ? "5GHz" : "2.4GHz";
            int pct = WifiManager.calculateSignalLevel(sr.level, 100);

            JSObject item = new JSObject();
            item.put("ssid", ssid);
            item.put("bssid", sr.BSSID != null ? sr.BSSID : "");
            item.put("level", sr.level);
            item.put("signalPct", pct);
            item.put("band", band);
            item.put("secured", secured);
            item.put("connected", ssid.equals(currentSsid));
            networks.put(item);
        }

        JSObject ret = new JSObject();
        ret.put("status", "ok");
        ret.put("currentSsid", currentSsid);
        ret.put("networks", networks);
        call.resolve(ret);
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void connectWifi(PluginCall call) {
        String ssid = call.getString("ssid", "").trim();
        String password = call.getString("password", "");

        if (ssid.isEmpty()) {
            call.reject("Vui lòng chọn hoặc nhập tên mạng Wi-Fi.");
            return;
        }

        Context ctx = getContext();
        WifiManager wifiManager = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifiManager == null) {
            call.reject("Thiết bị không hỗ trợ Wi-Fi.");
            return;
        }

        if (!wifiManager.isWifiEnabled()) {
            try { wifiManager.setWifiEnabled(true); } catch (Exception ignored) {}
        }

        // Android 10+ (API 29+): Kết nối ngầm 100% trong app qua WifiNetworkSuggestion (không mở bảng hệ thống)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                if (!password.isEmpty()) {
                    ClipboardManager clipboard = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (clipboard != null) {
                        clipboard.setPrimaryClip(ClipData.newPlainText("wifi_pass", password));
                    }
                }

                WifiNetworkSuggestion.Builder sugBuilder = new WifiNetworkSuggestion.Builder()
                    .setSsid(ssid);
                if (!password.isEmpty()) {
                    sugBuilder.setWpa2Passphrase(password);
                }
                List<WifiNetworkSuggestion> sugList = Collections.singletonList(sugBuilder.build());
                wifiManager.removeNetworkSuggestions(sugList);
                int status = wifiManager.addNetworkSuggestions(sugList);

                // Kích hoạt quét ngay để hệ thống tự bắt mạng vừa đề xuất
                try { wifiManager.startScan(); } catch (Exception ignored) {}

                JSObject res = new JSObject();
                res.put("suggested", true);
                res.put("status", status);
                res.put("ssid", ssid);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Lỗi đề xuất Wi-Fi: " + e.getMessage());
            }
            return;
        }

        // Android 9 trở xuống: Kết nối trực tiếp 100% trong app
        ioExecutor.execute(() -> {
            try {
                WifiConfiguration conf = new WifiConfiguration();
                conf.SSID = "\"" + ssid + "\"";
                if (password.isEmpty()) {
                    conf.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
                } else {
                    conf.preSharedKey = "\"" + password + "\"";
                }
                int netId = wifiManager.addNetwork(conf);
                if (netId == -1) {
                    call.reject("Không thể lưu cấu hình Wi-Fi \"" + ssid + "\".");
                    return;
                }
                wifiManager.disconnect();
                wifiManager.enableNetwork(netId, true);
                wifiManager.reconnect();

                Thread.sleep(3500);
                String ip = resolveLocalIpv4(ctx, wifiManager);
                JSObject res = new JSObject();
                res.put("connected", true);
                res.put("ssid", ssid);
                res.put("ip", ip);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Lỗi kết nối Wi-Fi: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void openWifiSettings(PluginCall call) {
        mainHandler.post(() -> {
            sTempUnpinnedForWifi = true;
            Activity act = getActivity();
            if (act != null) {
                try { act.stopLockTask(); } catch (Exception ignored) {}
            }
            Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? new Intent(Settings.Panel.ACTION_WIFI)
                : new Intent(Settings.ACTION_WIFI_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        });
    }

    // ==================== 3. NATIVE HTTP BRIDGE (SERVER SYNC FALLBACK) ====================

    @PluginMethod
    public void httpGet(PluginCall call) {
        String urlStr = call.getString("url", "");
        if (urlStr.isEmpty()) {
            call.reject("Missing url");
            return;
        }
        ioExecutor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(12000);
                conn.setReadTimeout(20000);
                conn.setRequestProperty("Accept", "application/json");
                conn.setRequestProperty("User-Agent", "Robot2027Pro/1.5.0");

                int code = conn.getResponseCode();
                InputStream stream = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
                BufferedReader br = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = br.readLine()) != null) {
                    sb.append(line);
                }
                br.close();

                JSObject ret = new JSObject();
                ret.put("status", code);
                ret.put("body", sb.toString());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("HTTP GET error: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    // ==================== 4. BRIGHTNESS, VOLUME, TTS, FAST & ACCURATE STT, KIOSK ====================

    @PluginMethod
    public void setBrightness(PluginCall call) {
        int level = call.getInt("level", 70);
        float val = Math.max(0.02f, Math.min(1.0f, level / 100.0f));
        mainHandler.post(() -> {
            Activity activity = getActivity();
            if (activity != null) {
                WindowManager.LayoutParams lp = activity.getWindow().getAttributes();
                lp.screenBrightness = val;
                activity.getWindow().setAttributes(lp);
            }
            JSObject ret = new JSObject();
            ret.put("level", level);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        int level = Math.max(0, Math.min(100, call.getInt("level", 80)));
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am != null) {
            int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            int target = Math.round((level / 100.0f) * max);
            am.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0);
        }
        JSObject ret = new JSObject();
        ret.put("level", level);
        call.resolve(ret);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String lang = call.getString("lang", "en-US");
        float rate = call.getFloat("rate", 0.95f);
        float pitch = call.getFloat("pitch", 1.08f);

        if (tts == null || text.isEmpty()) {
            call.resolve();
            return;
        }

        mainHandler.post(() -> {
            if (speechRecognizer != null) {
                try {
                    speechRecognizer.stopListening();
                    speechRecognizer.cancel();
                } catch (Exception ignored) {}
                isListening = false;
            }
            Locale locale = lang.startsWith("vi") ? new Locale("vi", "VN") : Locale.US;
            tts.setLanguage(locale);
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            Bundle params = new Bundle();
            String uttId = "utt_" + System.currentTimeMillis();
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, uttId);
            call.resolve();
        });
    }

    @PluginMethod
    public void stopSpeak(PluginCall call) {
        if (tts != null) {
            tts.stop();
        }
        call.resolve();
    }

    private void ensureSpeechRecognizerInstance() {
        if (speechRecognizer != null) return;
        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
        speechRecognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) {
                mainHandler.postDelayed(() -> muteBeep(false), 250);
            }
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() { isListening = false; }
            @Override public void onError(int error) {
                isListening = false;
                muteBeep(false);
                // Bỏ qua lỗi ERROR_CLIENT phát sinh khi hủy phiên nghe cũ để chuyển sang chấm điểm tiếng Anh
                if (error == SpeechRecognizer.ERROR_CLIENT) {
                    return;
                }
                if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) {
                    try { speechRecognizer.destroy(); } catch (Exception ignored) {}
                    speechRecognizer = null;
                }
                JSObject err = new JSObject();
                err.put("code", error);
                notifyListeners("speechError", err);
            }
            @Override public void onResults(Bundle results) {
                isListening = false;
                ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                String best = (matches != null && !matches.isEmpty()) ? matches.get(0) : "";
                JSObject res = new JSObject();
                res.put("text", best);
                notifyListeners("speechResult", res);
            }
            @Override public void onPartialResults(Bundle partialResults) {
                ArrayList<String> matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (matches != null && !matches.isEmpty()) {
                    JSObject res = new JSObject();
                    res.put("text", matches.get(0));
                    notifyListeners("speechPartial", res);
                }
            }
            @Override public void onEvent(int eventType, Bundle params) {}
        });
    }

    @PluginMethod
    public void startListening(PluginCall call) {
        String lang = call.getString("lang", "vi-VN");
        boolean isEnglishLesson = lang.toLowerCase(Locale.ROOT).startsWith("en");

        mainHandler.post(() -> {
            try {
                muteBeep(true);
                ensureSpeechRecognizerInstance();
                try {
                    speechRecognizer.cancel();
                } catch (Exception ignored) {}

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                // Tiếng Anh học bài chờ 1.5s để bé đọc trọn câu; lệnh tiếng Việt ngắt nhanh 0.65s
                long silenceMs = isEnglishLesson ? 1500L : 650L;
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, silenceMs);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, silenceMs);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);

                isListening = true;
                speechRecognizer.startListening(intent);
                call.resolve();
            } catch (Exception e) {
                muteBeep(false);
                call.reject("Mic error: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        mainHandler.post(() -> {
            isListening = false;
            if (speechRecognizer != null) {
                try {
                    speechRecognizer.stopListening();
                    speechRecognizer.cancel();
                } catch (Exception ignored) {}
            }
            muteBeep(false);
            call.resolve();
        });
    }

    private void muteBeep(boolean mute) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            if (mute) {
                if (savedNotifVol < 0) {
                    savedNotifVol = am.getStreamVolume(AudioManager.STREAM_NOTIFICATION);
                }
                am.setStreamVolume(AudioManager.STREAM_NOTIFICATION, 0, 0);
            } else if (savedNotifVol >= 0) {
                am.setStreamVolume(AudioManager.STREAM_NOTIFICATION, savedNotifVol, 0);
                savedNotifVol = -1;
            }
        } catch (Exception ignored) {}
    }

    @PluginMethod
    public void setKioskMode(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        sKioskLocked = enabled;
        if (enabled) {
            sTempUnpinnedForWifi = false;
        }
        mainHandler.post(() -> {
            applyKioskFlags(getActivity(), enabled);
            JSObject ret = new JSObject();
            ret.put("kioskLocked", sKioskLocked);
            call.resolve(ret);
        });
    }
}
