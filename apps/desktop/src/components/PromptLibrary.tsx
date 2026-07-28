import type { PromptTemplate, PromptTemplateCategory } from "@p2i/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, LoaderCircle, Plus, Save, Search, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { deletePromptTemplate, listPromptTemplates, upsertPromptTemplate } from "../lib/bridge";
import { PROMPT_CATEGORIES } from "../lib/promptTemplates";
import { useWorkspace } from "../store";

type PromptDraft = { id?: string; category: PromptTemplateCategory; name: string; content: string; sortOrder: number };

export function PromptLibrary() {
  const root = useWorkspace((state) => state.root);
  const queryClient = useQueryClient();
  const [activeCategory, setActiveCategory] = useState<PromptTemplateCategory>("reader");
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const templatesQuery = useQuery({
    queryKey: ["prompt-templates", root],
    queryFn: () => listPromptTemplates(root),
    enabled: Boolean(root),
    retry: false,
  });
  const templates = templatesQuery.data ?? [];
  const categoryCounts = useMemo(() => new Map(PROMPT_CATEGORIES.map((category) => [category.id, templates.filter((template) => template.category === category.id).length])), [templates]);
  const visibleTemplates = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return templates.filter((template) => template.category === activeCategory && (!needle || `${template.name} ${template.content}`.toLowerCase().includes(needle)));
  }, [activeCategory, search, templates]);
  const activeDefinition = PROMPT_CATEGORIES.find((category) => category.id === activeCategory)!;

  useEffect(() => {
    if (draft && draft.category === activeCategory) return;
    const selected = visibleTemplates.find((template) => template.id === selectedId) ?? visibleTemplates[0];
    setSelectedId(selected?.id ?? "");
    setDraft(selected ? toDraft(selected) : null);
  }, [activeCategory, templatesQuery.data]);

  const edit = (template: PromptTemplate) => {
    setActiveCategory(template.category);
    setSelectedId(template.id);
    setDraft(toDraft(template));
    setNotice(null);
  };
  const create = () => {
    setSelectedId("");
    setDraft({ category: activeCategory, name: "", content: "", sortOrder: categoryCounts.get(activeCategory) ?? 0 });
    setNotice(null);
  };
  const save = async () => {
    if (!draft?.name.trim() || !draft.content.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const saved = await upsertPromptTemplate(root, { ...draft, name: draft.name.trim(), content: draft.content.trim() });
      await queryClient.invalidateQueries({ queryKey: ["prompt-templates", root] });
      setActiveCategory(saved.category);
      setSelectedId(saved.id);
      setDraft(toDraft(saved));
      setNotice({ kind: "success", text: `“${saved.name}”已保存。` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!draft?.id || !window.confirm(`删除提示词“${draft.name}”？`)) return;
    setBusy(true);
    setNotice(null);
    try {
      await deletePromptTemplate(root, draft.id);
      await queryClient.invalidateQueries({ queryKey: ["prompt-templates", root] });
      setSelectedId("");
      setDraft(null);
      setNotice({ kind: "success", text: "提示词已删除。" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  if (templatesQuery.isLoading) return <main className="prompt-library-page prompt-library-loading"><LoaderCircle className="spin" size={21} /> 正在读取提示词库…</main>;
  if (templatesQuery.isError) return <main className="prompt-library-page prompt-library-loading"><TriangleAlert size={21} /> {templatesQuery.error instanceof Error ? templatesQuery.error.message : "无法打开提示词库"}</main>;

  return <main className="prompt-library-page">
    <header className="prompt-library-header">
      <div><span><Sparkles size={20} /></span><div><h1>提示词库</h1><p>{templates.length} 个本地模板</p></div></div>
      <button className="primary-button compact" onClick={create}><Plus size={14} /> 新建提示词</button>
    </header>
    <div className="prompt-library-layout">
      <aside className="prompt-category-rail" aria-label="提示词分类">
        {PROMPT_CATEGORIES.map((category) => {
          const Icon = category.icon;
          return <button key={category.id} className={activeCategory === category.id ? "active" : ""} onClick={() => { setActiveCategory(category.id); setDraft(null); setSelectedId(""); setNotice(null); }}><span><Icon size={16} /></span><span><strong>{category.label}</strong><small>{category.description}</small></span><b>{categoryCounts.get(category.id) ?? 0}</b></button>;
        })}
      </aside>
      <section className="prompt-template-column">
        <header><div><strong>{activeDefinition.label}</strong><small>{categoryCounts.get(activeCategory) ?? 0} 个模板</small></div><button title={`新建${activeDefinition.label}提示词`} onClick={create}><Plus size={14} /></button></header>
        <label className="prompt-library-search"><Search size={13} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称或正文" /></label>
        <div className="prompt-template-list">{visibleTemplates.map((template) => <button key={template.id} className={draft?.id === template.id ? "active" : ""} onClick={() => edit(template)}><FileText size={15} /><span><strong>{template.name}</strong><small>{template.content}</small></span></button>)}{visibleTemplates.length === 0 && <div className="prompt-template-empty"><FileText size={24} /><strong>{search ? "没有匹配的提示词" : "该分类还没有提示词"}</strong>{!search && <button onClick={create}>新建模板</button>}</div>}</div>
      </section>
      <section className="prompt-library-editor">
        {draft ? <>
          <div className="prompt-editor-fields">
            <label><span>名称</span><input maxLength={160} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：方法与实验对比" /></label>
            <label><span>分类</span><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as PromptTemplateCategory })}>{PROMPT_CATEGORIES.map((category) => <option value={category.id} key={category.id}>{category.label}</option>)}</select></label>
          </div>
          <label className="prompt-editor-content"><span>提示词正文</span><textarea maxLength={50000} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="输入完整提示词…" /><small>{draft.content.length.toLocaleString()} / 50,000</small></label>
          <footer>{draft.id ? <button className="danger-link" onClick={() => void remove()} disabled={busy}><Trash2 size={13} /> 删除</button> : <span />}{notice && <span className={`prompt-library-notice ${notice.kind}`}>{notice.text}</span>}<button className="primary-button compact" onClick={() => void save()} disabled={busy || !draft.name.trim() || !draft.content.trim()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />} 保存提示词</button></footer>
        </> : <div className="prompt-editor-empty"><FileText size={30} /><strong>选择或新建提示词</strong><button className="primary-button compact" onClick={create}><Plus size={13} /> 新建提示词</button></div>}
      </section>
    </div>
  </main>;
}

function toDraft(template: PromptTemplate): PromptDraft {
  return { id: template.id, category: template.category, name: template.name, content: template.content, sortOrder: template.sortOrder };
}
