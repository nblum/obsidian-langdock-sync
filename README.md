# Langdock Sync

Langdock Sync gleicht freigegebene Markdown-Notizen aus einem Obsidian-Vault mit einer ausgewählten Langdock-Wissensdatenbank ab. Es arbeitet mit gespeicherten Dateien im Vault, einschließlich lokaler Notizen ohne Git-Commit. Classificator und Langdock Sync sind eigenständige Plugins. Beide verwenden dieselbe YAML-Eigenschaft `classification`.

## Installation

1. Verwende Obsidian **1.12.4** oder neuer. Entpacke den Build so, dass `main.js`, `manifest.json` und `styles.css` unter `.obsidian/plugins/langdock-sync/` im Vault liegen. Lade Obsidian neu und aktiviere **Langdock Sync** unter **Community-Plugins**.
2. Erstelle in den Langdock-API-Einstellungen einen Workspace-API-Key mit dem Scope `KNOWLEDGE_FOLDER_API` und gib ihm die Rolle **Editor** in der gewünschten Wissensdatenbank. Hinterlege den Key unter **Einstellungen → Langdock Sync**. **Key speichern** legt ihn in Obsidian SecretStorage unter der festen ID `langdock-api` ab. [Langdock-API-Einstellungen](https://app.langdock.com/settings/workspace/products/api) · [Obsidian SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage) · [Langdock Knowledge Folder API](https://docs.langdock.com/en/developer/knowledge-folder-api/knowledge-folder-overview)
3. Lade die Wissensdatenbanken, wähle das Ziel und klicke auf **Verbindung testen**.
4. Wähle unter **Ordner verwalten** mindestens einen Ordner. Prüfe die **Vorschau** und starte **Jetzt synchronisieren**. **Automatisch synchronisieren** ist anfangs aus.

Langdock Sync folgt der Obsidian-Sprache. Die Sprachauswahl steht unter den Plugin-Informationen am Anfang der Einstellungen. Verfügbar sind Deutsch, Englisch, Französisch, Italienisch, Spanisch, Niederländisch, brasilianisches und europäisches Portugiesisch sowie vereinfachtes Chinesisch. Für andere Obsidian-Sprachen verwendet das Plugin Englisch.

Beim ersten Öffnen zeigt das Plugin eine dreistufige Einführung. Die Schaltflächen **Einführung anzeigen** und **Über Langdock Sync** stehen direkt unter der Sprachauswahl. Beide Dialoge sind auch über die Befehlspalette erreichbar.

## Freigabe und Abgleich

Die Ordnerauswahl umfasst jeweils die Unterordner. **Gesamter Vault (/)** erlaubt den gesamten Vault. Eine leere Auswahl verhindert den Abgleich. Beim Abgleich werden verwaltete Kopien entfernt, wenn ihre Dateien die Ordner- oder Eigenschaftsfilter nicht mehr erfüllen.

YAML-Filter unter **Eigenschaften verwalten** sind optional. Standardmäßig ist `classification: public` ausgewählt. Mehrere Werte für dieselbe Eigenschaft gelten als Alternativen. Verschiedene Eigenschaften müssen jeweils passen. Bei einer YAML-Liste genügt ein passender Eintrag. Die Einstufung kannst du mit [Obsidian Classificator](https://github.com/nblum/obsidian-classificator) pflegen.

Unabhängig von den Filtern muss im YAML-Frontmatter genau eine `classification` mit dem Wert `public` oder `internal` stehen. Ein explizites `langdock_sync: false`, fehlende oder ungültige Freigaben, `_meta.md` und versteckte Pfade werden übersprungen. Das Plugin überträgt den vollständigen Inhalt einer freigegebenen Markdown-Datei einschließlich Frontmatter.

Der automatische Abgleich läuft beim Öffnen des Vaults und fasst schnelle Änderungen zusammen. Unveränderte Dateien werden anhand ihrer Inhalts-Hashes erkannt. Nach einer Änderung bleibt die bisherige Version in Langdock verfügbar, bis die neue Version den Status `SYNCED` erreicht. Bei Freigabeentzug oder Löschen der Notiz entfernt das Plugin die anhand des Namensschemas zugeordnete Kopie. Eine Umbenennung ändert die Pfadkennung. Die Vorschau zeigt die alte Kopie zum Löschen und den neuen Pfad zum Hochladen.

Status und Fehlermeldungen stehen in den Plugin-Einstellungen. Nach vorübergehenden Verbindungsfehlern versucht der automatische Abgleich es erneut. Wenn Langdock eine Indexierung als fehlgeschlagen meldet, kannst du sie mit **Jetzt synchronisieren** für denselben Inhalt erneut anstoßen.

![Abgleichvorschau mit geplantem Upload, einer Aktualisierung und einer Löschung](assets/screenshots/preview.webp)

Weitere Aufnahmen zeigen Einführung, Verbindungseinstellungen, Filter und Abgleichstatus. [Alle Screenshots](assets/screenshots/)

## Wechsel vom GitHub-Workflow

1. Wähle denselben Vault und dieselbe Wissensdatenbank wie im bisherigen Workflow. Deaktiviere in GitHub Actions den Workflow **Langdock-Wissensdatenbank aktualisieren** (`.github/workflows/sync-langdock.yml`) und warte laufende Läufe ab.
2. Lass den automatischen Plugin-Abgleich zunächst aus. Wähle die gewünschten Ordner und prüfe die Vorschau für das bisherige Ziel. Dateien aus dem Python-Skript werden anhand ihrer Pfad- und Inhalts-Hashes erkannt. Bei unverändertem Inhalt verwendet das Plugin den vorhandenen Upload weiter.
3. Starte den ersten Abgleich manuell. Aktiviere danach den automatischen Abgleich genau auf dem Gerät, das diese Wissensdatenbank pflegen soll. Verwende pro Wissensdatenbank genau einen automatischen Abgleich.

Die vom Plugin verwalteten Namen beginnen mit dem lesbaren Notiztitel. Der Suffix `--obsidian-nblum-<Pfad-Hash>-<Inhalts-Hash>.md` ist für den Abgleich reserviert. Manuelle Uploads mit regulären Dateinamen bleiben erhalten.

## Lokal bauen

Mit der in `.nvmrc` festgelegten Node.js-Version erzeugst du `main.js` für die Installation.

```sh
nvm install
npm ci
npm run build
```

Entwicklungsbefehle und Tests stehen in [CONTRIBUTING.md](CONTRIBUTING.md).
