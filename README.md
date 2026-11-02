# ⚓ Marina Tekne & Mürettebat Rehberi

El yazısı mürettebat formlarını fotoğraftan okuyarak **tekne rehberi** oluşturan, orijinal form fotoğraflarını arşivleyen ve tüm ekibin her cihazdan erişebileceği yerel/web tabanlı rehber uygulaması.

---

## 🚀 Hızlı Başlangıç

1. Sunucuyu çalıştırmak için `baslat.bat` dosyasına çift tıklayın veya terminalde şu komutu çalıştırın:
   ```bash
   node server.js
   ```

2. Tarayıcınızdan açın:
   * **Kendi Bilgisayarınızdan:** [http://localhost:3000](http://localhost:3000)
   * **Ekipteki Diğer Telefon ve Bilgisayarlardan:** `http://10.136.31.74:3000` *(aynı Wi-Fi veya marina ağına bağlı olmaları yeterlidir)*

---

## 🌟 Temel Özellikler

1. **Giriş / Şifre Zahmeti Yok:**
   * Ekip içinde herkes verilen linke tıklayıp rehberi görebilir, arama yapabilir ve yeni form yükleyebilir.
2. **Kalıcı Veritabanı (SQLite):**
   * Tüm tekneler ve mürettebat bilgileri `data/rehber.db` SQLite dosyasında kalıcı olarak saklanır.
   * Bilgisayar kapansa bile veriler asla kaybolmaz.
3. **Orijinal Form Fotoğrafı Arşivi:**
   * Çekilen/yüklenen her fiziki form `public/uploads/` klasöründe saklanır.
   * Tekne kartındaki **"🖼️ Orijinal Formu Gör"** butonuna basıldığında yüksek çözünürlüklü olarak ekranda açılır.
   * Ayrıca **"🖼️ Orijinal Formlar"** sekmesinden tüm yüklenmiş belgeler galeri halinde incelenebilir.
4. **Hızlı İletişim (Telefon & WhatsApp):**
   * Numaraya dokunulduğunda doğrudan arama (`tel:`) yapar veya WhatsApp konuşmasını açar.
5. **Tek Tıkla vCard (.vcf) ve Excel (.csv) İndirme:**
   * Teknedeki tüm personeli telefonun kendi rehberine tek dokunuşla kaydetme.
   * Tüm tekne listesini Excel uyumlu CSV olarak indirme.
6. **Yapay Zekâ (Gemini Vision) Entegrasyonu:**
   * Yeni form yüklendiğinde el yazısını otomatik tanır; tekne adı, sorumlu kaptan ve mürettebat tablosunu doldurur.
   * Önizleme ekranında gerekirse elle düzenleme imkanı sağlar.
