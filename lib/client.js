// analyze-image-tool browser half — the eye button in the session header and
// its settings/profile/test panel. This file is deliberately dependency-free
// at the module level except for `react`, which the dsh client module loader
// provides. No JSX, no build step: source is the shipped artifact.
window.__ModuleLoader__.load({
  id: "analyze-image-tool",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect } = React;
    const el = React.createElement;

    const SETTINGS_API = "/api/analyze-image-tool/settings";
    const TEST_API = "/api/analyze-image-tool/test";

    const EMPTY_FORM = {
      baseURL: "",
      model: "",
      apiKey: "",
      maxTokens: 2048,
      timeoutMs: 60000,
      maxImageBytes: 10485760,
      defaultQuestion: "",
      composerNoteTemplate: "",
    };

    const panelStyle = {
      position: "absolute",
      top: "calc(100% + 8px)",
      right: 0,
      width: 340,
      maxWidth: "calc(100vw - 24px)",
      zIndex: 50,
      display: "flex",
      flexDirection: "column",
      gap: 8,
      padding: "10px 12px",
      borderRadius: 8,
      border: "1px solid var(--dsh-color-border, #80808059)",
      background: "var(--dsh-color-surface-elevated, #1f1f1f)",
      color: "var(--dsh-color-text, inherit)",
      fontSize: 12,
      boxShadow: "0 4px 12px #0000004d",
    };

    const embeddedPanelStyle = {
      display: "flex",
      flexDirection: "column",
      gap: 8,
      padding: "4px 2px",
      color: "var(--dsh-color-text, inherit)",
      fontSize: 12,
    };

    const buttonStyle = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      height: 22,
      padding: "0 8px",
      borderRadius: 999,
      border: "1px solid var(--dsh-color-border, #80808059)",
      background: "var(--dsh-color-surface, transparent)",
      color: "var(--dsh-color-text, inherit)",
      cursor: "pointer",
      fontSize: 12,
      lineHeight: 1,
      whiteSpace: "nowrap",
    };

    const actionStyle = {
      ...buttonStyle,
      height: 26,
      borderColor: "var(--dsh-color-accent, #50a0ffb3)",
      color: "var(--dsh-color-accent, #50a0ffe6)",
    };

    const inputStyle = {
      boxSizing: "border-box",
      width: "100%",
      height: 26,
      padding: "0 8px",
      borderRadius: 6,
      border: "1px solid var(--dsh-color-border, #80808059)",
      background: "var(--dsh-color-surface, transparent)",
      color: "var(--dsh-color-text, inherit)",
      fontSize: 12,
      outline: "none",
    };

    function Field(props) {
      return el(
        "label",
        { style: { display: "flex", flexDirection: "column", gap: 3 } },
        el("span", { style: { opacity: 0.75 } }, props.label),
        props.children,
      );
    }

    function EyeDockEntry() {
      const [open, setOpen] = useState(false);
      return el(
        "div",
        { style: { position: "relative", display: "inline-flex" } },
        el(
          "button",
          { type: "button", title: "analyze-image-tool", style: buttonStyle, onClick: () => setOpen((v) => !v) },
          el("span", { "aria-hidden": "true" }, "👁"),
        ),
        open ? el(SettingsPanel, { onClose: () => setOpen(false) }) : null,
      );
    }

    function SettingsPanel(props) {
      const embedded = props.embedded === true;
      const style = embedded ? embeddedPanelStyle : panelStyle;
      const [form, setForm] = useState(null);
      const [apiKeySet, setApiKeySet] = useState(false);
      const [profiles, setProfiles] = useState([]);
      const [activeProfile, setActiveProfile] = useState("default");
      const [selectedProfileId, setSelectedProfileId] = useState("default");
      const [profileName, setProfileName] = useState("");
      const [loadError, setLoadError] = useState("");
      const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
      const [saveError, setSaveError] = useState("");
      const [testState, setTestState] = useState("idle"); // idle | testing
      const [testResult, setTestResult] = useState(null);

      const applyView = (view) => {
        setForm({
          baseURL: view.baseURL ?? "",
          model: view.model ?? "",
          apiKey: "",
          maxTokens: view.maxTokens ?? 2048,
          timeoutMs: view.timeoutMs ?? 60000,
          maxImageBytes: view.maxImageBytes ?? 10485760,
          defaultQuestion: view.defaultQuestion ?? "",
          composerNoteTemplate: view.composerNoteTemplate ?? "",
        });
        setApiKeySet(view.apiKeySet === true);
        setProfiles(Array.isArray(view.profiles) ? view.profiles : []);
        setActiveProfile(view.activeProfile ?? "default");
        setSelectedProfileId(view.activeProfile ?? "default");
      };

      const load = () => {
        fetch(SETTINGS_API)
          .then((response) => response.json())
          .then((view) => {
            applyView(view);
          })
          .catch((error) => {
            setLoadError(error instanceof Error ? error.message : String(error));
          });
      };

      useEffect(() => {
        load();
      }, []);

      const set = (key) => (event) => {
        const value = event.target.value;
        setForm((prev) => ({ ...prev, [key]: value }));
        setSaveState("idle");
        setSaveError("");
      };

      const setNumber = (key) => (event) => {
        const value = event.target.value === "" ? 0 : Number(event.target.value);
        setForm((prev) => ({ ...prev, [key]: value }));
        setSaveState("idle");
        setSaveError("");
      };

      const postSettings = async (body) => {
        const response = await fetch(SETTINGS_API, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const view = await response.json();
        if (!response.ok || view.ok !== true) {
          throw new Error(view.error ?? "save failed");
        }
        applyView(view);
        return view;
      };

      const save = async () => {
        if (form === null) return;
        setSaveState("saving");
        setSaveError("");
        const patch = {
          baseURL: form.baseURL,
          model: form.model,
          maxTokens: Number(form.maxTokens),
          timeoutMs: Number(form.timeoutMs),
          maxImageBytes: Number(form.maxImageBytes),
          defaultQuestion: form.defaultQuestion,
          composerNoteTemplate: form.composerNoteTemplate,
        };
        if (form.apiKey !== "") patch.apiKey = form.apiKey;
        try {
          await postSettings(patch);
          setSaveState("saved");
        } catch (error) {
          setSaveState("error");
          setSaveError(error instanceof Error ? error.message : String(error));
        }
      };

      const clearApiKey = async () => {
        setSaveState("saving");
        setSaveError("");
        try {
          await postSettings({ clearApiKey: true });
          setSaveState("saved");
        } catch (error) {
          setSaveState("error");
          setSaveError(error instanceof Error ? error.message : String(error));
        }
      };

      const switchProfile = async () => {
        setSaveState("saving");
        setSaveError("");
        try {
          await postSettings({ mode: "switchProfile", profileId: selectedProfileId });
          setSaveState("saved");
          setTestResult(null);
        } catch (error) {
          setSaveState("error");
          setSaveError(error instanceof Error ? error.message : String(error));
        }
      };

      const saveProfile = async () => {
        const name = profileName.trim();
        if (name === "") {
          setSaveState("error");
          setSaveError("请输入方案名称");
          return;
        }
        setSaveState("saving");
        setSaveError("");
        const fields = {
          baseURL: form.baseURL,
          model: form.model,
          maxTokens: Number(form.maxTokens),
          timeoutMs: Number(form.timeoutMs),
          maxImageBytes: Number(form.maxImageBytes),
          defaultQuestion: form.defaultQuestion,
          composerNoteTemplate: form.composerNoteTemplate,
        };
        if (form.apiKey !== "") fields.apiKey = form.apiKey;
        try {
          await postSettings({ mode: "saveProfile", profileId: name, profileName: name, profile: fields });
          setSaveState("saved");
        } catch (error) {
          setSaveState("error");
          setSaveError(error instanceof Error ? error.message : String(error));
        }
      };

      const updateSelectedProfile = async () => {
        setSaveState("saving");
        setSaveError("");
        const fields = {
          baseURL: form.baseURL,
          model: form.model,
          maxTokens: Number(form.maxTokens),
          timeoutMs: Number(form.timeoutMs),
          maxImageBytes: Number(form.maxImageBytes),
          defaultQuestion: form.defaultQuestion,
          composerNoteTemplate: form.composerNoteTemplate,
        };
        if (form.apiKey !== "") fields.apiKey = form.apiKey;
        try {
          await postSettings({
            mode: "updateProfile",
            profileId: selectedProfileId,
            profileName: profileName.trim() === "" ? undefined : profileName.trim(),
            profile: fields,
          });
          setSaveState("saved");
        } catch (error) {
          setSaveState("error");
          setSaveError(error instanceof Error ? error.message : String(error));
        }
      };

      const deleteProfile = async () => {
        if (selectedProfileId === "default") {
          setSaveState("error");
          setSaveError("默认方案不可删除");
          return;
        }
        if (selectedProfileId === activeProfile) {
          const confirmed =
            typeof window !== "undefined" &&
            typeof window.confirm === "function" &&
            window.confirm("删除当前活动方案将自动切换到默认方案，确定删除？");
          if (!confirmed) return;
        }
        setSaveState("saving");
        setSaveError("");
        try {
          await postSettings({ mode: "deleteProfile", profileId: selectedProfileId });
          setSaveState("saved");
        } catch (error) {
          setSaveState("error");
          setSaveError(error instanceof Error ? error.message : String(error));
        }
      };

      const test = async () => {
        setTestState("testing");
        setTestResult(null);
        try {
          const response = await fetch(TEST_API, { method: "POST" });
          const view = await response.json();
          setTestResult(view);
        } catch (error) {
          setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
        } finally {
          setTestState("idle");
        }
      };

      if (form === null) {
        return el(
          "div",
          { style },
          loadError === "" ? el("div", null, "加载中…") : el("div", { style: { color: "var(--dsh-color-danger, #e5534b)" } }, loadError),
          props.onClose ? el("button", { type: "button", style: actionStyle, onClick: props.onClose }, "关闭") : null,
        );
      }

      return el(
        "div",
        { style },
        el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
          el("strong", null, "analyze-image-tool"),
          props.onClose ? el("button", { type: "button", style: buttonStyle, onClick: props.onClose }, "×") : null),

        el("div", { style: { display: "flex", flexDirection: "column", gap: 6, padding: "6px 0", borderBottom: "1px solid var(--dsh-color-border, #80808040)" } },
          el("span", { style: { opacity: 0.75 } }, "配置方案"),
          el("div", { style: { display: "flex", gap: 6 } },
            el("select", {
              value: selectedProfileId,
              onChange: (event) => {
                const id = event.target.value;
                setSelectedProfileId(id);
                const found = profiles.find((profile) => profile.id === id);
                setProfileName(found?.name ?? "");
              },
              style: { ...inputStyle, flex: 1 },
            },
              profiles.map((profile) => el("option", { key: profile.id, value: profile.id }, profile.name))),
            el("button", { type: "button", style: actionStyle, onClick: switchProfile, disabled: saveState === "saving" }, "切换"),
            el("button", { type: "button", style: actionStyle, onClick: updateSelectedProfile, disabled: saveState === "saving" || selectedProfileId !== activeProfile }, "更新所选方案"),
            el("button", { type: "button", style: buttonStyle, onClick: deleteProfile, disabled: saveState === "saving" || selectedProfileId === "default" }, "删除")),
          el("div", { style: { display: "flex", gap: 6 } },
            el("input", {
              type: "text",
              value: profileName,
              onChange: (event) => setProfileName(event.target.value),
              style: { ...inputStyle, flex: 1 },
              placeholder: "方案名称，如：硅基流动 / 本地 Ollama",
            }),
            el("button", { type: "button", style: actionStyle, onClick: saveProfile, disabled: saveState === "saving" }, "保存为方案"))),

        el(Field, { label: "baseURL" },
          el("input", { type: "text", value: form.baseURL, onChange: set("baseURL"), style: inputStyle, placeholder: "https://api.siliconflow.cn/v1" })),
        el(Field, { label: "apiKey" },
          el("input", {
            type: "password",
            value: form.apiKey,
            onChange: set("apiKey"),
            style: inputStyle,
            placeholder: apiKeySet ? "已设置，留空保持不变" : "未设置",
          })),
        apiKeySet
          ? el("button", { type: "button", style: buttonStyle, onClick: clearApiKey, disabled: saveState === "saving" }, "清除已保存的 apiKey")
          : null,
        el(Field, { label: "model" },
          el("input", { type: "text", value: form.model, onChange: set("model"), style: inputStyle })),
        el(Field, { label: "maxTokens" },
          el("input", { type: "number", value: form.maxTokens, onChange: setNumber("maxTokens"), style: inputStyle, min: 1, max: 65536, step: 1 })),
        el(Field, { label: "timeoutMs" },
          el("input", { type: "number", value: form.timeoutMs, onChange: setNumber("timeoutMs"), style: inputStyle, min: 1000, max: 300000, step: 1 })),
        el(Field, { label: "maxImageBytes" },
          el("input", { type: "number", value: form.maxImageBytes, onChange: setNumber("maxImageBytes"), style: inputStyle, min: 1, step: 1 })),
        el(Field, { label: "defaultQuestion" },
          el("textarea", { value: form.defaultQuestion, onChange: set("defaultQuestion"), style: { ...inputStyle, height: 52, padding: "4px 8px", resize: "vertical" } })),
        el(Field, { label: "composerNoteTemplate（{attachment_id} / {image_index}）" },
          el("textarea", { value: form.composerNoteTemplate, onChange: set("composerNoteTemplate"), style: { ...inputStyle, height: 52, padding: "4px 8px", resize: "vertical" } })),

        el("div", { style: { display: "flex", gap: 8 } },
          el("button", { type: "button", style: actionStyle, onClick: save, disabled: saveState === "saving" },
            saveState === "saving" ? "保存中…" : "保存"),
          el("button", { type: "button", style: actionStyle, onClick: test, disabled: testState === "testing" },
            testState === "testing" ? "测试中…" : "测试连通性")),
        saveState === "saved" ? el("div", { style: { color: "var(--dsh-color-success, #3fb950)" } }, "已保存") : null,
        saveState === "error" ? el("div", { style: { color: "var(--dsh-color-danger, #e5534b)" } }, saveError) : null,
        testResult !== null
          ? el("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
              testResult.ok === true
                ? el("div", { style: { color: "var(--dsh-color-success, #3fb950)" } },
                    `连通：${testResult.model ?? ""}，${testResult.latencyMs ?? "?"}ms`)
                : el("div", { style: { color: "var(--dsh-color-danger, #e5534b)" } },
                    `失败：${testResult.error ?? "unknown"}`))
          : null,
      );
    }

    function SettingsTab() {
      return el(SettingsPanel, { embedded: true });
    }

    const inject = ["slots"];
    function apply(ctx) {
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "analyze-image-tool",
        order: 130,
      }, EyeDockEntry));

      // Also mount the same panel as a tab inside the web UI's system
      // settings modal (设置 → 插件 → 识图插件). The slot is declared by
      // @deepseek-ai/dsh-client-ui-settings-plugins, which ships with dsh web.
      ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
        name: "settings.plugins.tab",
        id: "analyze-image-tool",
        order: 50,
        label: "识图插件",
      }, SettingsTab));
    }

    exports.EyeDockEntry = EyeDockEntry;
    exports.SettingsTab = SettingsTab;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
