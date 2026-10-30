import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { captureDraftTarget, commentDraftAnchorText, commentDraftSnapshot, isCommentDraftSource, matchesDraftAnchor, matchesDraftTarget, putCommentDraft, removeCommentDraft, subscribeCommentDrafts, type CommentDraft, type CommentDraftAnchor, type CommentDraftTarget } from '../comment-draft-recovery'
import type { Node as PmNode } from '@tiptap/pm/model'
import type { CommentInfo } from '@vantage/docx-engine'
import { useI18n } from '../i18n/locale'
import { IconComment, IconPencil, IconTrash } from './icons'

function formatDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** anchor text quoted from the document, to orient comments whose range spans paragraphs (one DOM pass for all threads) */
function collectAnchorTexts(): Map<string, string> {
  const out = new Map<string, string>()
  for (const span of document.querySelectorAll<HTMLElement>(
    '.ProseMirror:not(.mp-page) .doc-comment',
  )) {
    const text = span.textContent ?? ''
    for (const id of (span.dataset.commentIds ?? '').split(' ')) {
      if (id) out.set(id, (out.get(id) ?? '') + text)
    }
  }
  return out
}

function jumpTo(id: string) {
  const spans = document.querySelectorAll<HTMLElement>('.ProseMirror:not(.mp-page) .doc-comment')
  const targets = [...spans].filter((s) => (s.dataset.commentIds ?? '').split(' ').includes(id))
  if (targets.length === 0) return
  targets[0].scrollIntoView({ behavior: 'smooth', block: 'center' })
  for (const t of targets) {
    t.classList.remove('doc-comment-flash')
    // restart the CSS animation when jumping to the same comment twice
    void t.offsetWidth
    t.classList.add('doc-comment-flash')
  }
}

/**
 * Word's comments pane: list + jump-to-anchor, a composer when New Comment was
 * clicked (composing), and per-comment delete.
 */
export const CommentsPanel = memo(function CommentsPanel({
  comments,
  docNode,
  composing,
  onSubmitNew,
  onReply,
  onEdit,
  onResolve:resolveAction,
  onCancelNew:cancelNewAction,
  onDelete:deleteAction,
  onClose:closeAction,
  focus,
  selectionAnchor,
}: {
  comments: CommentInfo[]
  /** current PM doc, used only as the anchor-scan cache key (doc unchanged ⇒ anchors unchanged) */
  docNode: PmNode
  /** show the new-comment composer (selection captured by the caller) */
  composing: boolean
  onSubmitNew: (text: string, anchor:CommentDraftAnchor) => boolean
  /** Reply to a comment (anchor shares the parent comment's range) */
  onReply: (parentId: string, text: string, expected:CommentDraftTarget) => boolean
  /** Replace a comment's or reply's text in place; author, date and anchor stay */
  onEdit: (id: string, text: string, expected:CommentDraftTarget) => boolean
  /** Resolve/reopen the whole thread */
  onResolve: (id: string, done: boolean) => void
  onCancelNew: () => void
  onDelete: (id: string) => void
  onClose: () => void
  /** thread to highlight and scroll to (Review > Previous / Next); nonce re-fires for the same id */
  focus?: { id: string; nonce: number } | null
  selectionAnchor: () => CommentDraftAnchor | undefined
}) {
  const { t } = useI18n()
  const recovery=useSyncExternalStore(subscribeCommentDrafts,commentDraftSnapshot,commentDraftSnapshot)
  const source=useRef(recovery.source).current
  const onResolve=(id:string,done:boolean)=>{if(isCommentDraftSource(source))resolveAction(id,done)}
  const onDelete=(id:string)=>{if(isCommentDraftSource(source))deleteAction(id)}
  const onClose=()=>{if(isCommentDraftSource(source))closeAction()}
  const onCancelNew=()=>{if(isCommentDraftSource(source)){removeCommentDraft(source,'new');setDraft('');cancelNewAction()}}
  const [notice,setNotice]=useState('')
  const [recoveredTargets,setRecoveredTargets]=useState<Record<string,CommentDraftTarget>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState(()=>recovery.drafts.find(value=>value.id==='new'&&!value.recovered)?.text??'')
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  // Word: resolved comments are collapsed/hidden by default
  const [showResolved, setShowResolved] = useState(false)

  const anchorTexts = useMemo(collectAnchorTexts, [docNode, comments])
  const anchorFor=(id:string)=>commentDraftAnchorText(docNode,comments,id)
  const store=(draft:CommentDraft)=>putCommentDraft(source,draft)
  const updateNew=(text:string)=>{setDraft(text);const previous=recovery.drafts.find(value=>value.id==='new');store({id:'new',kind:'new',text,anchor:previous?.anchor??selectionAnchor()})}
  const updateReply=(text:string)=>{setReplyDraft(text);if(replyTo){const previous=recovery.drafts.find(value=>value.id==='reply:'+replyTo);store({id:'reply:'+replyTo,kind:'reply',text,target:previous?.target??captureDraftTarget(comments,replyTo,anchorFor(replyTo))})}}
  const updateEdit=(text:string)=>{setEditDraft(text);if(editingId){const previous=recovery.drafts.find(value=>value.id==='edit:'+editingId);store({id:'edit:'+editingId,kind:'edit',text,target:previous?.target??captureDraftTarget(comments,editingId,anchorFor(editingId))})}}
  const targetStillCurrent=(id:string,kind:'reply'|'edit')=>{
    const saved=recovery.drafts.find(value=>value.id===kind+':'+id)
    return isCommentDraftSource(source)&&matchesDraftTarget(comments,saved?.target,anchorFor(id))
  }

  const topLevel = comments.filter((c) => !c.parentId)
  const openThreads = topLevel.filter((c) => !c.done)
  const resolvedThreads = topLevel.filter((c) => c.done)
  const repliesOf = (id: string) => comments.filter((c) => c.parentId === id)
  const cancelReply=()=>{if(replyTo)removeCommentDraft(source,'reply:'+replyTo);setReplyTo(null);setReplyDraft('')}
  const cancelEdit=()=>{if(editingId)removeCommentDraft(source,'edit:'+editingId);setEditingId(null);setEditDraft('')}
  const submitReply = () => {
    const text = replyDraft.trim()
    if (!text || !replyTo) return
    const expected=recovery.drafts.find(value=>value.id==='reply:'+replyTo)?.target
    if(!expected||!targetStillCurrent(replyTo,'reply')||!onReply(replyTo,text,expected)){setNotice('The thread changed. Your draft is kept; choose its current target below.');setReplyTo(null);return}
    removeCommentDraft(source,'reply:'+replyTo)
    setReplyDraft('')
    setReplyTo(null)
  }

  const startEdit = (c: CommentInfo) => {
    // the pencil toggles: a second click cancels instead of resetting the draft
    if (editingId === c.id) {
      cancelEdit()
      return
    }
    setEditingId(c.id)
    const retained=recovery.drafts.find(value=>value.id==='edit:'+c.id&&!value.recovered)
    setEditDraft(retained?.text??c.text)
    if(!retained)store({id:'edit:'+c.id,kind:'edit',text:c.text,target:captureDraftTarget(comments,c.id,anchorFor(c.id))})
    setReplyTo(null)
  }

  const submitEdit = () => {
    const text = editDraft.trim()
    if (!text || !editingId) return
    const expected=recovery.drafts.find(value=>value.id==='edit:'+editingId)?.target
    if(!expected||!targetStillCurrent(editingId,'edit')||!onEdit(editingId,text,expected)){setNotice('The comment changed. Your draft is kept; choose its current target below.');setEditingId(null);return}
    removeCommentDraft(source,'edit:'+editingId)
    setEditingId(null)
  }

  /** Collapsing a thread retains unsent edits without publishing them. */
  const flushEditIn = (threadId: string) => {
    if (!editingId) return
    if (editingId !== threadId && !repliesOf(threadId).some((r) => r.id === editingId)) return
    setEditingId(null)
  }

  /** the edited comment is going away — drop the draft with it */
  const cancelEditIn = (ids: string[]) => {
    if (editingId && ids.includes(editingId)) setEditingId(null)
  }

  useEffect(() => {
    if (composing) draftRef.current?.focus()
  }, [composing])

  useEffect(() => {
    if (!focus) return
    setActiveId(focus.id)
    if (comments.some((c) => c.id === focus.id && c.done)) setShowResolved(true)
    requestAnimationFrame(() => {
      if(!isCommentDraftSource(source))return
      document
        .querySelector(`.comments-pane [data-comment-id="${CSS.escape(focus.id)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    })
    // comments only matter at fire time; re-running on every edit would re-scroll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    const saved=recovery.drafts.find(value=>value.id==='new')
    if(!isCommentDraftSource(source))return
    if(!matchesDraftAnchor(docNode,saved?.anchor)||!saved?.anchor||!onSubmitNew(text,saved.anchor)){setNotice('The selected text changed. Your draft is kept; select its current text below.');if(saved)store({...saved,recovered:true});setDraft('');cancelNewAction();return}
    removeCommentDraft(source,'new')
    setDraft('')
  }

  const continueRetained=(saved:CommentDraft)=>{
    if(!isCommentDraftSource(source))return
    if(saved.kind==='new'){
      const anchor=selectionAnchor()
      if(!anchor||!matchesDraftAnchor(docNode,anchor)||!onSubmitNew(saved.text,anchor)){setNotice('Select the text for this comment. Its unsent draft is kept.');return}
    }else{
      const target=recoveredTargets[saved.id],id=target?.id??''
      if(!target||!matchesDraftTarget(comments,target,anchorFor(id))||(saved.kind==='reply'&&target.parentId!==null)){setNotice('Choose a current comment or thread. Its unsent draft is kept.');return}
      if(!(saved.kind==='reply'?onReply(id,saved.text,target):onEdit(id,saved.text,target))){setNotice('That target changed. Its unsent draft is kept.');return}
    }
    removeCommentDraft(source,saved.id)
    if(saved.id==='new')setDraft('')
    if(saved.id==='reply:'+replyTo){setReplyTo(null);setReplyDraft('')}
    if(saved.id==='edit:'+editingId){setEditingId(null);setEditDraft('')}
    setNotice('')
  }

  const onActivate = (fn: () => void) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    e.stopPropagation()
    fn()
  }

  const renderThread = (c: CommentInfo) => {
    const anchor = anchorTexts.get(c.id) ?? ''
    const replies = repliesOf(c.id)
    const head = (
      <div className="comment-card-head">
        <span className="comment-avatar">{(c.initials || c.author || '?').slice(0, 2)}</span>
        <span className="comment-author">{c.author || t('appUnknownAuthor')}</span>
        <span className="comment-date">{formatDate(c.date)}</span>
        {c.done && <span className="comment-resolved-badge">{t('appResolved')}</span>}
        <span
          className="comment-card-edit"
          data-tip={t('appEditComment')}
          role="button"
          aria-label={t('appEditComment')}
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            startEdit(c)
          }}
          onKeyDown={onActivate(() => startEdit(c))}
        >
          <IconPencil size={13} />
        </span>
        <span
          className="comment-card-del"
          data-tip={replies.length > 0 ? t('appDeleteCommentWithReplies') : t('appDeleteComment')}
          role="button"
          aria-label={t('appDeleteComment')}
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            cancelEditIn([c.id, ...replies.map((r) => r.id)])
            onDelete(c.id)
          }}
          onKeyDown={onActivate(() => {
            cancelEditIn([c.id, ...replies.map((r) => r.id)])
            onDelete(c.id)
          })}
        >
          <IconTrash size={13} />
        </span>
      </div>
    )
    return (
      <div
        key={c.id}
        data-comment-id={c.id}
        className={`comment-thread ${c.done ? 'resolved' : ''}`}
      >
        {editingId === c.id ? (
          // editing swaps the clickable card for a plain one: a textarea cannot live inside a button
          <div className={`comment-card ${activeId === c.id ? 'active' : ''}`}>
            {head}
            {anchor && <div className="comment-anchor">“{anchor.slice(0, 60)}”</div>}
            <div className="comment-reply-compose">
              <textarea
                autoFocus
                value={editDraft}
                onChange={(e) => updateEdit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitEdit()
                  if (e.key === 'Escape') cancelEdit()
                }}
              />
              <div className="comment-compose-actions">
                <button onClick={cancelEdit}>{t('appCancel')}</button>
                <button className="primary" disabled={!editDraft.trim()} onClick={submitEdit}>
                  {t('appSave')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            className={`comment-card ${activeId === c.id ? 'active' : ''}`}
            onClick={() => {
              if(!isCommentDraftSource(source))return
              setActiveId(c.id)
              jumpTo(c.id)
            }}
          >
            {head}
            {anchor && <div className="comment-anchor">“{anchor.slice(0, 60)}”</div>}
            <div className="comment-text">{c.text}</div>
          </button>
        )}
        {replies.map((r) => (
          <div key={r.id} className="comment-reply">
            <div className="comment-card-head">
              <span className="comment-avatar">{(r.initials || r.author || '?').slice(0, 2)}</span>
              <span className="comment-author">{r.author || t('appUnknownAuthor')}</span>
              <span className="comment-date">{formatDate(r.date)}</span>
              <span
                className="comment-card-edit"
                data-tip={t('appEditComment')}
                aria-label={t('appEditComment')}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  startEdit(r)
                }}
                onKeyDown={onActivate(() => startEdit(r))}
              >
                <IconPencil size={12} />
              </span>
              <span
                className="comment-card-del"
                data-tip={t('appDeleteReply')}
                aria-label={t('appDeleteReply')}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  cancelEditIn([r.id])
                  onDelete(r.id)
                }}
                onKeyDown={onActivate(() => {
                  cancelEditIn([r.id])
                  onDelete(r.id)
                })}
              >
                <IconTrash size={12} />
              </span>
            </div>
            {editingId === r.id ? (
              <div className="comment-reply-compose">
                <textarea
                  autoFocus
                  value={editDraft}
                  onChange={(e) => updateEdit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitEdit()
                    if (e.key === 'Escape') cancelEdit()
                  }}
                />
                <div className="comment-compose-actions">
                  <button onClick={cancelEdit}>{t('appCancel')}</button>
                  <button className="primary" disabled={!editDraft.trim()} onClick={submitEdit}>
                    {t('appSave')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="comment-text">{r.text}</div>
            )}
          </div>
        ))}
        <div className="comment-thread-actions">
          {replyTo === c.id ? (
            <div className="comment-reply-compose">
              <textarea
                autoFocus
                placeholder={t('appReplyPlaceholder')}
                value={replyDraft}
                onChange={(e) => updateReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitReply()
                  if (e.key === 'Escape') cancelReply()
                }}
              />
              <div className="comment-compose-actions">
                <button onClick={cancelReply}>{t('appCancel')}</button>
                <button className="primary" disabled={!replyDraft.trim()} onClick={submitReply}>
                  {t('appReply')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button onClick={() => {setReplyTo(c.id);const saved=recovery.drafts.find(value=>value.id==='reply:'+c.id&&!value.recovered);setReplyDraft(saved?.text??'')}}>{t('appReply')}</button>
              <button
                onClick={() => {
                  // resolving collapses the thread and would unmount an open composer: commit first
                  flushEditIn(c.id)
                  onResolve(c.id, !c.done)
                }}
              >
                {c.done ? t('appReopen') : t('appResolve')}
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  if(!isCommentDraftSource(source))return null
  return (
    <aside className="comments-pane">
      <div className="comments-pane-head">
        <span className="comments-pane-title">
          <IconComment size={14} /> {t('appCommentsTitle', { n: comments.length })}
        </span>
        <button
          className="comments-pane-close"
          data-tip={t('appClose')}
          aria-label={t('appClose')}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {(notice||recovery.error)&&<p role="status">{recovery.error??notice}</p>}
      {recovery.drafts.filter(saved=>saved.text.trim()&&(saved.recovered||(saved.kind==='new'?!composing:saved.kind==='reply'?saved.id!=='reply:'+replyTo:saved.id!=='edit:'+editingId))).map(saved=>(
        <div className="comment-compose" key={'retained:'+saved.id}>
          <strong>{saved.recovered?'Recovered unsent draft':'Retained unsent draft'} — {saved.kind==='new'?'comment':saved.kind}</strong>
          <p>This text has not been posted. Choose its current text or comment before submitting.</p>
          {(saved.target?.text||saved.anchor?.quote)&&<div className="comment-anchor">Previous context: {saved.target?.text??saved.anchor?.quote}</div>}
          <textarea defaultValue={saved.text} onChange={event=>store({...saved,text:event.target.value})}/>
          {saved.kind!=='new'&&<select aria-label="Choose the current comment target" value={recoveredTargets[saved.id]?.id??''} onChange={event=>{const target=captureDraftTarget(comments,event.target.value,anchorFor(event.target.value));setRecoveredTargets(values=>{const next={...values};if(target)next[saved.id]=target;else delete next[saved.id];return next})}}>
            <option value="">Choose a current {saved.kind==='reply'?'thread':'comment'}</option>
            {comments.filter(comment=>saved.kind==='edit'||!comment.parentId).map(comment=><option value={comment.id} key={comment.id}>{comment.author}: {comment.text.slice(0,80)}</option>)}
          </select>}
          <div className="comment-compose-actions">
            <button onClick={()=>removeCommentDraft(source,saved.id)}>Discard draft</button>
            <button className="primary" disabled={!saved.text.trim()||(saved.kind!=='new'&&!recoveredTargets[saved.id])} onClick={()=>continueRetained(saved)}>{saved.kind==='new'?'Post to selected text':saved.kind==='reply'?'Post reply to chosen thread':'Apply edit to chosen comment'}</button>
          </div>
        </div>
      ))}
      {composing && (
        <div className="comment-compose">
          <textarea
            ref={draftRef}
            placeholder={t('appCommentPlaceholder')}
            value={draft}
            onChange={(e) => updateNew(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
              if (e.key === 'Escape') onCancelNew()
            }}
          />
          <div className="comment-compose-actions">
            <button onClick={onCancelNew}>{t('appCancel')}</button>
            <button className="primary" disabled={!draft.trim()} onClick={submit}>
              {t('appCommentBtn')}
            </button>
          </div>
        </div>
      )}
      <div className="comments-pane-list">
        {openThreads.map(renderThread)}
        {resolvedThreads.length > 0 && (
          <div className="comments-resolved-group">
            <button className="comments-resolved-toggle" onClick={() => setShowResolved((v) => !v)}>
              <span className={`comments-resolved-caret ${showResolved ? 'open' : ''}`}>▸</span>
              {t('appResolvedComments', { n: resolvedThreads.length })}
            </button>
            {showResolved && resolvedThreads.map(renderThread)}
          </div>
        )}
        {comments.length === 0 && !composing && (
          <div className="comments-empty">{t('appNoComments')}</div>
        )}
      </div>
    </aside>
  )
})
