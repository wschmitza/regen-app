# Projektkontext für Claude

## Entwicklungsumgebung des Nutzers
- MacBook Air M4 vorhanden → iOS-Builds lokal mit Xcode möglich (kein Cloud-Build nötig).

## Offenes Vorhaben: TestFlight
- Ziel: Regenzeit (PWA) per Capacitor als native iOS-App nach TestFlight bringen.
- Offen, Rückmeldung des Nutzers steht aus: Apple Developer Program, Bundle-ID, Datenschutz-URL.
- Geplante Schritte: Capacitor-Hülle, @capacitor/geolocation, Regen-Alarm im nativen Build zunächst
  ausblenden (später APNs statt Web-Push im push-worker), ITSAppUsesNonExemptEncryption=NO,
  PrivacyInfo.xcprivacy, App-Icon 1024×1024, Fonts/Leaflet lokal einbinden.
