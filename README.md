# Robot 2027 — Phiên Bản V1.4 Pro (Update 9)

Dự án hoàn chỉnh đóng gói chuẩn **Capacitor Android + GitHub Actions** sẵn sàng import vào **Spck Editor** và tự động biên dịch file `.apk`.

## Các nâng cấp chính trong Update 9
1. **Quét & Kết nối Bluetooth 2 chế độ (BLE + Classic):**
   - Tích hợp bộ quét Native Android (`RobotNativePlugin.java`) quét đồng thời thiết bị đã ghép đôi, Bluetooth Classic (điện thoại khác, loa Bluetooth, TV, HC-05) và Bluetooth Low Energy (mạch ESP32) kèm mức sóng RSSI.
2. **Quét danh sách Wi-Fi + Bàn phím ảo nhập mật khẩu + Kết nối trực tiếp:**
   - Tự động quét và xổ danh sách các mạng Wi-Fi xung quanh (hiển thị tên mạng, cường độ sóng, băng tần 2.4GHz/5GHz, trạng thái bảo mật).
   - Chạm vào tên Wi-Fi để chọn và tự động bật bàn phím ảo nhập mật khẩu rồi kết nối ngay.
3. **Giao diện Cài đặt gọn gàng & Bảo mật Nhà phát triển:**
   - Ẩn hoàn toàn ô nhập đường dẫn Server trên giao diện.
   - Xóa gợi ý mật khẩu khỏi ô nhập mã nhà phát triển và sử dụng duy nhất mật khẩu chính thức `202799`.
4. **Đồng bộ đầy đủ toàn bộ Chủ đề & Bài học từ Server (`api.php`):**
   - Đồng bộ toàn bộ danh sách chủ đề và tải trọn gói câu học từ máy chủ (có cơ chế fallback HTTP Native chống lỗi mạng/CORS và chống tràn bộ nhớ đệm).
