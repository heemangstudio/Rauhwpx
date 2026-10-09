//! DeviceContext + DcStack + ObjectTable.
//!
//! EMF는 GDI 의미론을 따르며, SaveDC/RestoreDC로 상태 스택을 관리하고,
//! CreatePen/Brush/Font + SelectObject/DeleteObject로 그래픽 객체 핸들을 관리한다.

use std::collections::HashMap;

use crate::emf::parser::objects::{LogBrush, LogFontW, LogPen, XForm};

/// 그래픽 객체 핸들이 참조하는 구체 객체.
#[derive(Debug, Clone)]
pub enum GraphicsObject {
    Pen(LogPen),
    Brush(LogBrush),
    Font(LogFontW),
}

/// 렌더 상태 스냅샷(GDI Device Context 대응).
#[derive(Debug, Clone)]
pub struct DeviceContext {
    pub pen: Option<LogPen>,
    pub brush: Option<LogBrush>,
    pub font: Option<LogFontW>,
    pub text_color: u32,
    pub bk_color: u32,
    pub bk_mode: u32,    // 1=Transparent, 2=Opaque
    pub text_align: u32, // bitflags
    pub map_mode: u32,

    // 좌표계
    pub world_xform: XForm,
    pub window_org: (i32, i32),
    pub window_ext: (i32, i32),
    pub viewport_org: (i32, i32),
    pub viewport_ext: (i32, i32),
    pub current_pos: (i32, i32),
}

impl Default for DeviceContext {
    fn default() -> Self {
        Self {
            pen: None,
            brush: None,
            font: None,
            text_color: 0x00_00_00_00,
            bk_color: 0x00_FF_FF_FF,
            bk_mode: 2, // Opaque
            text_align: 0,
            map_mode: 1, // MM_TEXT
            world_xform: XForm::identity(),
            window_org: (0, 0),
            window_ext: (1, 1),
            viewport_org: (0, 0),
            viewport_ext: (1, 1),
            current_pos: (0, 0),
        }
    }
}

/// SaveDC 로 쌓을 수 있는 DC 최대 개수.
pub const MAX_DC_STACK_DEPTH: usize = 1024;

/// SaveDC/RestoreDC 스택.
#[derive(Debug, Default)]
pub struct DcStack {
    current: DeviceContext,
    stack: Vec<DeviceContext>,
}

impl DcStack {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 상한(`MAX_DC_STACK_DEPTH`)을 넘는 SaveDC 는 무시한다. 8바이트 EMR_SAVEDC 만
    /// 반복한 입력이 DC(글꼴 이름 포함)를 끝없이 복제하지 못하게 한다.
    pub fn save(&mut self) {
        if self.stack.len() < MAX_DC_STACK_DEPTH {
            self.stack.push(self.current.clone());
        }
    }

    /// EMR_RESTOREDC `iRelative` 규약:
    /// - 음수: 상대(−1 = 가장 최근 Save)
    /// - 양수: 절대 깊이 (1 기반)
    ///
    /// 단계 11은 음수(상대)만 지원. pop 개수 = `|relative|`.
    pub fn restore(&mut self, relative: i32) -> bool {
        if relative == 0 {
            return false;
        }
        let n = if relative < 0 {
            // `-i32::MIN` 은 넘친다 (디버그 패닉). 크기만 쓴다.
            relative.unsigned_abs() as usize
        } else {
            return false;
        };
        if self.stack.len() < n {
            return false;
        }
        let target_idx = self.stack.len() - n;
        self.stack.truncate(target_idx + 1);
        if let Some(dc) = self.stack.pop() {
            self.current = dc;
            true
        } else {
            false
        }
    }

    #[must_use]
    pub fn current(&self) -> &DeviceContext {
        &self.current
    }
    pub fn current_mut(&mut self) -> &mut DeviceContext {
        &mut self.current
    }
    #[must_use]
    pub fn depth(&self) -> usize {
        self.stack.len()
    }
}

/// 객체 핸들 테이블.
#[derive(Debug, Default)]
pub struct ObjectTable {
    handles: HashMap<u32, GraphicsObject>,
}

impl ObjectTable {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, handle: u32, obj: GraphicsObject) {
        self.handles.insert(handle, obj);
    }
    #[must_use]
    pub fn get(&self, handle: u32) -> Option<&GraphicsObject> {
        self.handles.get(&handle)
    }
    pub fn remove(&mut self, handle: u32) -> Option<GraphicsObject> {
        self.handles.remove(&handle)
    }
    #[must_use]
    pub fn len(&self) -> usize {
        self.handles.len()
    }
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.handles.is_empty()
    }
}
