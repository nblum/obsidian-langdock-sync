import { Modal } from "obsidian";
import type { App, PluginManifest } from "obsidian";
import type { TranslationKey, Translator } from "./i18n.ts";

const repository = "https://github.com/nblum/obsidian-langdock-sync";
const aboutLinks = [
  ["about.documentation", `${repository}#readme`],
  ["about.repository", repository],
  ["about.feedback", `${repository}/issues/new`],
  ["about.website", "https://blum-nico.de"],
  ["about.support", "https://ko-fi.com/blumnico"],
] as const satisfies readonly (readonly [TranslationKey, string])[];

export function renderAbout(
  contentEl: HTMLElement,
  t: Translator,
  manifest: Pick<PluginManifest, "version" | "author">,
): void {
  contentEl.createEl("p", { text: t("about.description") });

  const meta = contentEl.createEl("p", { cls: "langdock-sync-about-meta" });
  meta.createSpan({ text: t("about.version", { version: manifest.version }) });
  meta.createSpan({ text: t("about.author", { author: manifest.author }) });

  const links = contentEl.createEl("ul", { cls: "langdock-sync-about-links" });
  for (const [label, href] of aboutLinks) {
    links.createEl("li").createEl("a", {
      text: t(label),
      cls: "external-link",
      attr: { href, target: "_blank", rel: "noopener" },
    });
  }
}

export class AboutModal extends Modal {
  constructor(
    app: App,
    private readonly translate: Translator,
    private readonly manifest: PluginManifest,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, translate: t } = this;
    this.modalEl.addClass("langdock-sync-about");
    this.setTitle(t("commands.showAbout"));
    renderAbout(contentEl, t, this.manifest);

    contentEl.createDiv({ cls: "langdock-sync-dialog-actions" })
      .createEl("button", { text: t("dialog.close") })
      .addEventListener("click", () => { this.close(); });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export class IntroductionModal extends Modal {
  private step = 0;

  constructor(app: App, private readonly translate: Translator) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("langdock-sync-introduction");
    this.setTitle(this.translate("intro.title"));
    this.renderStep();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderStep(focusHeading = false): void {
    const { contentEl, translate: t } = this;
    const steps = [
      {
        title: t("intro.connectionTitle"),
        description: t("intro.connectionHelp", { test: t("settings.testConnection") }),
      },
      {
        title: t("intro.scopeTitle"),
        description: t("intro.scopeHelp"),
      },
      {
        title: t("intro.syncTitle"),
        description: t("intro.syncHelp", { preview: t("settings.preview"), sync: t("commands.syncNow") }),
      },
    ];
    const step = steps[this.step];
    if (!step) return;

    contentEl.empty();
    const heading = contentEl.createEl("h3", { text: step.title, attr: { tabindex: "-1" } });
    contentEl.createEl("p", { text: step.description });
    const actions = contentEl.createDiv({ cls: "langdock-sync-dialog-actions" });
    actions.createSpan({
      cls: "langdock-sync-introduction-progress",
      text: t("intro.progress", { current: this.step + 1, total: steps.length }),
    });

    if (this.step > 0) {
      actions.createEl("button", { text: t("intro.back") }).addEventListener("click", () => {
        this.step--;
        this.renderStep(true);
      });
    }
    const last = this.step === steps.length - 1;
    actions.createEl("button", { cls: "mod-cta", text: t(last ? "intro.finish" : "intro.next") })
      .addEventListener("click", () => {
        if (last) {
          this.close();
        } else {
          this.step++;
          this.renderStep(true);
        }
      });
    if (focusHeading) heading.focus();
  }
}
