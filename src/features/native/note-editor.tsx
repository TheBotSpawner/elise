"use client";

import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  SquareCode,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/**
 * The note editor (ADR-056): rich text on screen, Markdown in storage. TipTap's StarterKit
 * gives headings, bold, italic, lists, quote, code, code block, divider and links; the
 * Markdown extension reads and writes the note's text, so plain-text notes open as they are
 * and ELISE, search and Knowledge keep reading Markdown.
 */

const isSafeLink = (href: string) => /^(https?:\/\/|mailto:)/i.test(href);

function ToolButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      // Keep the selection in the editor while clicking the toolbar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none md:size-8",
        active ? "bg-accent-soft text-accent-text" : "text-muted hover:bg-active hover:text-fg",
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

function Toolbar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const { t } = useI18n();
  const x = t.native.notes.toolbar;
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      level: ([1, 2, 3] as const).find((l) => e.isActive("heading", { level: l })) ?? 0,
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      link: e.isActive("link"),
      code: e.isActive("code"),
      codeBlock: e.isActive("codeBlock"),
    }),
  });
  const chain = () => editor.chain().focus();
  return (
    <div
      role="toolbar"
      aria-label={x.label}
      // Phones (ADR-066): one swipeable row of 40px tools, never several rows of small icons.
      className="no-scrollbar flex items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1.5 md:flex-wrap md:overflow-visible"
    >
      <select
        aria-label={x.paragraph}
        value={s.level}
        onChange={(e) => {
          const level = Number(e.target.value) as 0 | 1 | 2 | 3;
          if (level) chain().setHeading({ level }).run();
          else chain().setParagraph().run();
        }}
        className="h-8 rounded-lg bg-transparent px-2 text-[13px] text-muted hover:bg-active focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <option value={0}>{x.paragraph}</option>
        <option value={1}>{x.h1}</option>
        <option value={2}>{x.h2}</option>
        <option value={3}>{x.h3}</option>
      </select>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      <ToolButton
        icon={Bold}
        label={x.bold}
        active={s.bold}
        onClick={() => chain().toggleBold().run()}
      />
      <ToolButton
        icon={Italic}
        label={x.italic}
        active={s.italic}
        onClick={() => chain().toggleItalic().run()}
      />
      <ToolButton icon={Link2} label={x.link} active={s.link} onClick={onLink} />
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      <ToolButton
        icon={List}
        label={x.bullet}
        active={s.bullet}
        onClick={() => chain().toggleBulletList().run()}
      />
      <ToolButton
        icon={ListOrdered}
        label={x.ordered}
        active={s.ordered}
        onClick={() => chain().toggleOrderedList().run()}
      />
      <ToolButton
        icon={Quote}
        label={x.quote}
        active={s.quote}
        onClick={() => chain().toggleBlockquote().run()}
      />
      {/* Less common: still one tap, without crowding the bar on mobile. */}
      <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
      <ToolButton
        icon={Code}
        label={x.code}
        active={s.code}
        onClick={() => chain().toggleCode().run()}
      />
      <ToolButton
        icon={SquareCode}
        label={x.codeBlock}
        active={s.codeBlock}
        onClick={() => chain().toggleCodeBlock().run()}
      />
      <ToolButton
        icon={Minus}
        label={x.divider}
        onClick={() => chain().setHorizontalRule().run()}
      />
    </div>
  );
}

export function NoteEditor({
  value,
  onChange,
  label,
}: {
  /** Markdown. */
  value: string;
  onChange: (markdown: string) => void;
  label: string;
}) {
  const { t } = useI18n();
  const x = t.native.notes.toolbar;
  const [linking, setLinking] = useState<string | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const openLink = useRef<() => void>(() => {});
  const editor = useEditor({
    // Next renders on the server first: the editor mounts on the client only.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true, isAllowedUri: (url) => isSafeLink(url) },
      }),
      Markdown,
    ],
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: {
        "aria-label": label,
        "aria-multiline": "true",
        role: "textbox",
        class: "prose-elise px-4 py-3 text-[15px] leading-[1.65]",
      },
      handleKeyDown: (_view, e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
          e.preventDefault();
          openLink.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getMarkdown()),
  });
  const startLink = () => {
    if (!editor) return;
    setLinking((editor.getAttributes("link").href as string | undefined) ?? "");
    setTimeout(() => linkInput.current?.focus(), 0);
  };
  // Ctrl/Cmd+K inside the editor opens the same link field as the toolbar.
  useEffect(() => {
    openLink.current = startLink;
  });
  const applyLink = () => {
    if (!editor || linking === null) return;
    const href = linking.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!href) chain.unsetLink().run();
    else if (isSafeLink(href)) chain.setLink({ href }).run();
    else if (/^[\w.-]+\.[a-z]{2,}/i.test(href)) chain.setLink({ href: `https://${href}` }).run();
    setLinking(null);
  };

  return (
    <div className="note-editor flex min-h-0 flex-col rounded-xl border border-border-strong bg-surface focus-within:border-accent">
      {editor && <Toolbar editor={editor} onLink={startLink} />}
      {linking !== null && (
        <form
          className="flex items-center gap-2 border-b border-border px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink();
          }}
        >
          <input
            ref={linkInput}
            aria-label={x.link}
            value={linking}
            placeholder={x.linkPlaceholder}
            onChange={(e) => setLinking(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setLinking(null);
                editor?.commands.focus();
              }
            }}
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 text-[13px] focus-visible:border-accent focus-visible:outline-none"
          />
          <button
            type="submit"
            className="h-8 rounded-lg px-2.5 text-[13px] text-accent-text hover:bg-active"
          >
            {x.apply}
          </button>
          <button
            type="button"
            onClick={() => {
              editor?.chain().focus().extendMarkRange("link").unsetLink().run();
              setLinking(null);
            }}
            className="h-8 rounded-lg px-2.5 text-[13px] text-muted hover:bg-active"
          >
            {x.removeLink}
          </button>
        </form>
      )}
      <EditorContent editor={editor} className="min-h-0 flex-1 overflow-y-auto" />
    </div>
  );
}
