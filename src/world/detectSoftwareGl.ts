import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

let cachedSoftwareGl: boolean | null = null;

/**
 * Detect software WebGL renderers (SwiftShader, llvmpipe, WARP) by querying
 * the WebGL2 renderer string once and immediately releasing the probe context.
 */
export function isSoftwareWebGl(): boolean {
  if (cachedSoftwareGl !== null) return cachedSoftwareGl;
  if (typeof document === 'undefined') {
    cachedSoftwareGl = false;
    return false;
  }

  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) {
      cachedSoftwareGl = true;
      return true;
    }
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const rendererStr = String(gl.getParameter(param) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    cachedSoftwareGl = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(rendererStr);
    return cachedSoftwareGl;
  } catch {
    cachedSoftwareGl = true;
    return true;
  }
}

/**
 * When running under software WebGL (frameloop="demand"), paces animation frames
 * using WebGL2 fenceSync + 80ms breathing room so CPU rasterization never starves
 * the main thread, DOM interactions, or headless screenshots.
 */
export function SoftwareGlPacer({ enabled }: { enabled: boolean }) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timerId = 0;

    const scheduleAfterDraw = () => {
      if (!alive) return;
      const ctx = gl.getContext() as WebGL2RenderingContext | null;
      if (ctx && typeof ctx.fenceSync === 'function') {
        const sync = ctx.fenceSync(ctx.SYNC_GPU_COMMANDS_COMPLETE, 0);
        ctx.flush();
        const poll = () => {
          if (!alive) {
            if (sync) ctx.deleteSync(sync);
            return;
          }
          const status = sync ? ctx.getSyncParameter(sync, ctx.SYNC_STATUS) : ctx.SIGNALED;
          if (status === ctx.UNSIGNALED) {
            timerId = window.setTimeout(poll, 8);
          } else {
            if (sync) ctx.deleteSync(sync);
            timerId = window.setTimeout(() => {
              if (!alive) return;
              invalidate();
              scheduleAfterDraw();
            }, 85);
          }
        };
        timerId = window.setTimeout(poll, 8);
      } else {
        timerId = window.setTimeout(() => {
          if (!alive) return;
          invalidate();
          scheduleAfterDraw();
        }, 100);
      }
    };

    invalidate();
    scheduleAfterDraw();

    return () => {
      alive = false;
      window.clearTimeout(timerId);
    };
  }, [enabled, gl, invalidate]);

  return null;
}
