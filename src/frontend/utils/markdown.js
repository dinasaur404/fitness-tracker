/**
 * Simple markdown to HTML converter for chat messages
 * Handles: bold, code, numbered lists, bullet lists
 */
export function formatMarkdown(text) {
  if (!text) return ''
  
  // Escape HTML first to prevent XSS
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  
  // Convert markdown to HTML
  // Bold: **text** (must do before single *)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  
  // Inline code: `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  
  // Process lines for lists
  const lines = html.split('\n')
  let inList = false
  let listType = null
  const processedLines = []
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const numberedMatch = line.match(/^(\d+)\.\s+(.+)$/)
    const bulletMatch = line.match(/^[-*]\s+(.+)$/)
    
    if (numberedMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) processedLines.push(listType === 'ol' ? '</ol>' : '</ul>')
        processedLines.push('<ol>')
        inList = true
        listType = 'ol'
      }
      processedLines.push('<li>' + numberedMatch[2] + '</li>')
    } else if (bulletMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) processedLines.push(listType === 'ol' ? '</ol>' : '</ul>')
        processedLines.push('<ul>')
        inList = true
        listType = 'ul'
      }
      processedLines.push('<li>' + bulletMatch[1] + '</li>')
    } else {
      if (inList) {
        processedLines.push(listType === 'ol' ? '</ol>' : '</ul>')
        inList = false
        listType = null
      }
      processedLines.push(line)
    }
  }
  
  // Close any open list
  if (inList) {
    processedLines.push(listType === 'ol' ? '</ol>' : '</ul>')
  }
  
  html = processedLines.join('\n')
  
  // Convert remaining newlines to <br> (but not inside lists)
  html = html.replace(/\n(?!<)/g, '<br>')
  html = html.replace(/>\n</g, '><')
  
  // Clean up multiple <br> tags
  html = html.replace(/(<br>){3,}/g, '<br><br>')
  
  return html
}
