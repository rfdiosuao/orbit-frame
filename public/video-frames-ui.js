const roles = ['first_frame', 'last_frame'];
const labels = { first_frame: '首帧', last_frame: '尾帧' };
const prefixes = { first_frame: 'firstFrame', last_frame: 'lastFrame' };
const $ = id => document.getElementById(id);

export function setupVideoFrames({ upload, preview, notice, locked, changed }) {
  let mode = 'text_to_video';
  const slots = { first_frame: null, last_frame: null };
  const busy = new Set();
  const needed = () => mode === 'text_to_video' ? [] : mode === 'image_to_video' ? ['first_frame'] : roles;

  function warnings() {
    const ratio = document.querySelector('input[name=ratio]:checked')?.value || '16:9';
    const [w, h] = ratio.split(':').map(Number);
    const mismatches = needed().filter(role => slots[role]?.width && Math.abs(slots[role].width / slots[role].height / (w / h) - 1) > 0.05);
    const messages = mismatches.length ? [`${mismatches.map(role => labels[role]).join('、')}与 ${ratio} 比例不同，生成时可能裁切或补边。`] : [];
    if (mode === 'first_last_frame' && slots.first_frame?.width && slots.last_frame?.width &&
        Math.abs((slots.first_frame.width / slots.first_frame.height) / (slots.last_frame.width / slots.last_frame.height) - 1) > 0.05) {
      messages.push('首帧和尾帧比例不同，建议使用相同比例的图片。');
    }
    $('frameWarning').textContent = messages.join(' ');
    $('frameWarning').hidden = !messages.length;
  }

  function render() {
    document.querySelectorAll('input[name=videoMode]').forEach(input => { input.checked = input.value === mode; });
    $('framePanel').hidden = mode === 'text_to_video';
    $('lastFrameSlot').hidden = mode !== 'first_last_frame';
    $('frameHeading').textContent = mode === 'first_last_frame' ? '从开始，到结束' : '添加首帧，让画面动起来';
    $('framePanel').classList.toggle('single-frame', mode === 'image_to_video');
    $('swapFrames').hidden = mode !== 'first_last_frame';
    $('swapFrames').disabled = busy.size > 0 || !slots.first_frame || !slots.last_frame;
    for (const role of roles) {
      const p = prefixes[role], frame = slots[role];
      $(p + 'Preview').hidden = !frame?.url;
      if (frame?.url) $(p + 'Preview').src = frame.url;
      else $(p + 'Preview').removeAttribute('src');
      $(p + 'Placeholder').hidden = !!frame?.url;
      $('remove' + p[0].toUpperCase() + p.slice(1)).hidden = !frame;
      $(p + 'Input').disabled = busy.has(role);
      $(p + 'Meta').textContent = busy.has(role) ? '正在上传到本机…' : frame ?
        `${frame.name || '已添加'}${frame.width ? ` · ${frame.width} × ${frame.height}` : ''}` : '尚未添加';
    }
    warnings(); changed?.();
  }

  function canEdit() {
    if (!locked()) return true;
    notice('已有提交需要确认。请先查询原任务；首尾帧会随原请求一起保留。', true);
    return false;
  }

  async function add(role, file) {
    if (!file || busy.has(role) || !canEdit()) return;
    if (!file.size || file.size > 20 * 1024 * 1024) { notice('图片不能为空，且每张不能超过 20 MB。', true); return; }
    if (!/\.(png|jpe?g|webp)$/i.test(file.name)) { notice('请选择 PNG、JPEG 或 WebP 图片。', true); return; }
    const old = slots[role];
    const url = URL.createObjectURL(file);
    busy.add(role); render();
    try {
      // Decode in the browser too, so a corrupt file never becomes a preview.
      const image = new Image(); image.src = url; await image.decode();
      const width = image.naturalWidth, height = image.naturalHeight;
      if (Math.min(width, height) < 300 || Math.max(width, height) > 6000) throw new Error('图片每边需为 300 到 6000 像素。');
      if (width / height < 0.4 || width / height > 2.5) throw new Error('图片比例需在 2:5 到 5:2 之间。');
      slots[role] = { name: file.name, width, height, url };
      render();
      const saved = await upload(file);
      slots[role] = { ...saved, name: file.name, url };
      if (old?.url) URL.revokeObjectURL(old.url);
      notice(`${labels[role]}已添加，可以继续填写提示词。`);
    } catch (error) {
      slots[role] = old; URL.revokeObjectURL(url);
      notice(error.name === 'EncodingError' ? '无法读取这张图片，请换一张有效的 PNG、JPEG 或 WebP 图片。' : error.message, true);
    } finally { busy.delete(role); render(); }
  }

  document.querySelectorAll('input[name=videoMode]').forEach(input => input.addEventListener('change', () => {
    if (busy.size) { notice('请等待图片上传完成后再切换模式。', true); render(); return; }
    if (!canEdit()) { render(); return; }
    mode = input.value; render();
  }));
  for (const role of roles) {
    const p = prefixes[role], input = $(p + 'Input'), drop = input.closest('.frame-drop');
    input.addEventListener('click', event => { if (!canEdit()) event.preventDefault(); });
    input.addEventListener('change', () => { const file = input.files?.[0]; input.value = ''; void add(role, file); });
    drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('drag-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
    drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('drag-over'); void add(role, event.dataTransfer.files?.[0]); });
    $('remove' + p[0].toUpperCase() + p.slice(1)).addEventListener('click', () => {
      if (busy.has(role) || !canEdit()) return;
      if (slots[role]?.url) URL.revokeObjectURL(slots[role].url);
      slots[role] = null; render();
    });
  }
  $('swapFrames').addEventListener('click', () => {
    if (busy.size || !canEdit()) return;
    [slots.first_frame, slots.last_frame] = [slots.last_frame, slots.first_frame]; render();
  });
  document.querySelectorAll('input[name=ratio]').forEach(input => input.addEventListener('change', warnings));
  render();

  return {
    isBusy: () => busy.size > 0,
    request() {
      if (busy.size) throw new Error('图片正在上传，请稍等。');
      const result = { mode };
      for (const role of needed()) {
        if (!slots[role]?.path) throw new Error(`请先添加${labels[role]}图片。`);
        result[role] = { path: slots[role].path };
      }
      return result;
    },
    assets() {
      return Object.fromEntries(needed().filter(role => slots[role]?.path).map(role => {
        const { url, ...asset } = slots[role]; return [role, asset];
      }));
    },
    restore(draft) {
      mode = ['text_to_video', 'image_to_video', 'first_last_frame'].includes(draft?.mode) ? draft.mode : 'text_to_video';
      for (const role of needed()) if (draft?.[role]?.path) slots[role] = { ...draft.frameAssets?.[role], path: draft[role].path };
      render();
    },
    async restorePreviews() {
      for (const role of roles) {
        const frame = slots[role];
        if (!frame?.path || frame.url || !frame.preview_url) continue;
        try {
          const blob = await preview(frame.preview_url);
          if (slots[role] === frame) { frame.url = URL.createObjectURL(blob); render(); }
        } catch { /* A failed preview must not alter a pending request's frames. */ }
      }
    },
  };
}
