use crate::overlay::PixelRect;
use anyhow::{bail, Result};
use std::collections::HashSet;
use std::ptr::null_mut;
use windows::Win32::Foundation::{COLORREF, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateSolidBrush, DeleteObject, FillRect, RoundRect, SelectObject, HDC, HGDIOBJ,
};
use windows::Win32::Graphics::GdiPlus::{
    FillModeAlternate, GdipCreateFromHDC, GdipCreateMatrix2, GdipCreatePen1, GdipCreateSolidFill,
    GdipDeleteBrush, GdipDeleteGraphics, GdipDeleteMatrix, GdipDeletePen, GdipDrawArcI,
    GdipDrawEllipseI, GdipDrawLineI, GdipDrawLinesI, GdipDrawRectangleI, GdipFillEllipseI,
    GdipFillPolygonI, GdipFillRectangleI, GdipRestoreGraphics, GdipSaveGraphics, GdipSetPenEndCap,
    GdipSetPenLineJoin, GdipSetPenStartCap, GdipSetSmoothingMode, GdipSetWorldTransform,
    GdiplusShutdown, GdiplusStartup, GdiplusStartupInput, GpBrush, GpGraphics, GpPen, GpSolidFill,
    LineCapRound, LineJoinRound, Matrix, Ok as GdiPlusOk, Point as GpPoint,
    SmoothingModeAntiAlias8x8, UnitPixel,
};

const TOOLBAR_HEIGHT: i32 = 52;
const TOOLBAR_PADDING: i32 = 8;
const BUTTON_WIDTH: i32 = 44;
const BUTTON_GAP: i32 = 4;
const STYLE_HEIGHT: i32 = 44;
const PANEL_RADIUS: i32 = 9;
const ICON_SCALE: f32 = 0.78;
const MAX_POINTS: usize = 12_000;
const COLORS: [[u8; 3]; 7] = [
    [239, 68, 68],
    [249, 115, 22],
    [250, 204, 21],
    [34, 197, 94],
    [59, 130, 246],
    [20, 20, 20],
    [255, 255, 255],
];

pub struct GdiPlusSession {
    token: usize,
}

impl GdiPlusSession {
    pub fn start() -> Result<Self> {
        let input = GdiplusStartupInput {
            GdiplusVersion: 1,
            ..Default::default()
        };
        let mut token = 0_usize;
        let status = unsafe { GdiplusStartup(&mut token, &input, null_mut()) };
        if status != GdiPlusOk || token == 0 {
            bail!("start GDI+ failed with status {}", status.0);
        }
        Ok(Self { token })
    }
}

impl Drop for GdiPlusSession {
    fn drop(&mut self) {
        if self.token != 0 {
            unsafe { GdiplusShutdown(self.token) };
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum EditorIntent {
    Save,
    Copy,
}

impl EditorIntent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Save => "save",
            Self::Copy => "copy",
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum EditorAction {
    NotHandled,
    Handled,
    RequestTranslation,
    CancelTranslation,
    Finish(EditorIntent),
    Cancel,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum Tool {
    Select,
    Rectangle,
    Ellipse,
    Arrow,
    Pen,
    Mosaic,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum ToolbarButton {
    Rectangle,
    Ellipse,
    Arrow,
    Pen,
    Mosaic,
    Translate,
    Undo,
    Save,
    Cancel,
    Complete,
}

const BUTTONS: [ToolbarButton; 10] = [
    ToolbarButton::Rectangle,
    ToolbarButton::Ellipse,
    ToolbarButton::Arrow,
    ToolbarButton::Pen,
    ToolbarButton::Mosaic,
    ToolbarButton::Translate,
    ToolbarButton::Undo,
    ToolbarButton::Save,
    ToolbarButton::Cancel,
    ToolbarButton::Complete,
];

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum TranslationState {
    Idle,
    Loading { phase: u8 },
    Applied,
}

#[derive(Debug, Clone)]
enum Annotation {
    Rectangle {
        rect: PixelRect,
        color: [u8; 3],
        width: i32,
    },
    Ellipse {
        rect: PixelRect,
        color: [u8; 3],
        width: i32,
    },
    Arrow {
        start: POINT,
        end: POINT,
        color: [u8; 3],
        width: i32,
    },
    Pen {
        points: Vec<POINT>,
        color: [u8; 3],
        width: i32,
    },
    Mosaic {
        points: Vec<POINT>,
        size: i32,
    },
}

#[derive(Debug, Clone)]
enum Draft {
    Rectangle {
        start: POINT,
        end: POINT,
        color: [u8; 3],
        width: i32,
    },
    Ellipse {
        start: POINT,
        end: POINT,
        color: [u8; 3],
        width: i32,
    },
    Arrow {
        start: POINT,
        end: POINT,
        color: [u8; 3],
        width: i32,
    },
    Pen {
        points: Vec<POINT>,
        color: [u8; 3],
        width: i32,
    },
    Mosaic {
        points: Vec<POINT>,
        size: i32,
    },
}

#[derive(Clone, Copy)]
pub struct PixelSource {
    pub bits: *const u8,
    pub width: i32,
    pub height: i32,
}

impl PixelSource {
    fn pixel(self, x: i32, y: i32) -> [u8; 3] {
        if self.bits.is_null() || x < 0 || y < 0 || x >= self.width || y >= self.height {
            return [0, 0, 0];
        }
        let offset = ((y as usize * self.width as usize) + x as usize) * 4;
        unsafe {
            let source = std::slice::from_raw_parts(
                self.bits,
                self.width as usize * self.height as usize * 4,
            );
            [source[offset + 2], source[offset + 1], source[offset]]
        }
    }

    fn average(self, rect: PixelRect) -> [u8; 3] {
        let rect = rect.normalized(self.width, self.height);
        if rect.width < 1 || rect.height < 1 {
            return [0, 0, 0];
        }
        let step_x = (rect.width / 5).max(1);
        let step_y = (rect.height / 5).max(1);
        let mut red = 0_u64;
        let mut green = 0_u64;
        let mut blue = 0_u64;
        let mut count = 0_u64;
        let mut y = rect.y;
        while y < rect.bottom() {
            let mut x = rect.x;
            while x < rect.right() {
                let pixel = self.pixel(x, y);
                red += u64::from(pixel[0]);
                green += u64::from(pixel[1]);
                blue += u64::from(pixel[2]);
                count += 1;
                x += step_x;
            }
            y += step_y;
        }
        if count == 0 {
            [0, 0, 0]
        } else {
            [
                (red / count) as u8,
                (green / count) as u8,
                (blue / count) as u8,
            ]
        }
    }
}

pub struct EditorState {
    enabled: bool,
    chrome_visible: bool,
    tool: Tool,
    annotations: Vec<Annotation>,
    draft: Option<Draft>,
    toolbar: RECT,
    style_panel: RECT,
    hover: POINT,
    color_index: usize,
    size_index: usize,
    translation: TranslationState,
}

impl Default for EditorState {
    fn default() -> Self {
        Self {
            enabled: false,
            chrome_visible: false,
            tool: Tool::Select,
            annotations: Vec::new(),
            draft: None,
            toolbar: RECT::default(),
            style_panel: RECT::default(),
            hover: POINT { x: -1, y: -1 },
            color_index: 0,
            size_index: 1,
            translation: TranslationState::Idle,
        }
    }
}

impl EditorState {
    pub fn reset(&mut self, enabled: bool) {
        self.enabled = enabled;
        self.chrome_visible = false;
        self.tool = Tool::Select;
        self.annotations.clear();
        self.draft = None;
        self.toolbar = RECT::default();
        self.style_panel = RECT::default();
        self.hover = POINT { x: -1, y: -1 };
        self.color_index = 0;
        self.size_index = 1;
        self.translation = TranslationState::Idle;
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_chrome_visible(&mut self, visible: bool) {
        self.chrome_visible = self.enabled && visible;
        if !self.chrome_visible {
            self.tool = Tool::Select;
            self.draft = None;
            self.toolbar = RECT::default();
            self.style_panel = RECT::default();
        }
    }

    pub fn chrome_visible(&self) -> bool {
        self.enabled && self.chrome_visible
    }

    pub fn annotation_count(&self) -> usize {
        self.annotations.len()
    }

    pub fn is_drawing(&self) -> bool {
        self.draft.is_some()
    }

    pub fn translation_loading(&self) -> bool {
        matches!(self.translation, TranslationState::Loading { .. })
    }

    pub fn translation_applied(&self) -> bool {
        self.translation == TranslationState::Applied
    }

    pub fn translation_finished(&mut self) {
        self.translation = TranslationState::Applied;
    }

    pub fn translation_failed(&mut self) {
        self.translation = TranslationState::Idle;
    }

    pub fn clear_translation(&mut self) {
        self.translation = TranslationState::Idle;
    }

    pub fn advance_spinner(&mut self) -> bool {
        let TranslationState::Loading { phase } = &mut self.translation else {
            return false;
        };
        *phase = (*phase + 1) % 12;
        true
    }

    pub fn is_over_chrome(&self, point: POINT) -> bool {
        self.chrome_visible()
            && (point_in_rect(point, self.toolbar) || point_in_rect(point, self.style_panel))
    }

    pub fn wants_cross_cursor(&self, point: POINT, selection: PixelRect) -> bool {
        self.chrome_visible()
            && !self.translation_loading()
            && !self.is_over_chrome(point)
            && selection.contains(point)
            && self.tool != Tool::Select
    }

    pub fn show_magnifier(&self, point: POINT) -> bool {
        !self.enabled
            || (!self.translation_loading()
                && self.tool == Tool::Select
                && !self.is_over_chrome(point)
                && self.draft.is_none())
    }

    pub fn update_hover(&mut self, point: POINT) {
        self.hover = point;
    }

    pub fn pointer_down(
        &mut self,
        point: POINT,
        selection: PixelRect,
        surface_width: i32,
        surface_height: i32,
    ) -> EditorAction {
        if !self.chrome_visible() {
            return EditorAction::NotHandled;
        }
        self.layout(selection, surface_width, surface_height);
        if let Some(button) = self.toolbar_button_at(point) {
            return self.activate_button(button);
        }
        if self.translation_loading() {
            return EditorAction::Handled;
        }
        if self.apply_style_at(point) {
            return EditorAction::Handled;
        }
        if !selection.contains(point) || self.tool == Tool::Select {
            return EditorAction::NotHandled;
        }
        let color = COLORS[self.color_index];
        let width = self.stroke_width();
        self.draft = match self.tool {
            Tool::Rectangle => Some(Draft::Rectangle {
                start: point,
                end: point,
                color,
                width,
            }),
            Tool::Ellipse => Some(Draft::Ellipse {
                start: point,
                end: point,
                color,
                width,
            }),
            Tool::Arrow => Some(Draft::Arrow {
                start: point,
                end: point,
                color,
                width,
            }),
            Tool::Pen => Some(Draft::Pen {
                points: vec![point],
                color,
                width,
            }),
            Tool::Mosaic => Some(Draft::Mosaic {
                points: vec![point],
                size: self.mosaic_size(),
            }),
            Tool::Select => None,
        };
        EditorAction::Handled
    }

    pub fn pointer_move(&mut self, point: POINT, selection: PixelRect) -> bool {
        self.hover = point;
        let point = clamp_point(point, selection);
        let Some(draft) = self.draft.as_mut() else {
            return false;
        };
        match draft {
            Draft::Rectangle { end, .. }
            | Draft::Ellipse { end, .. }
            | Draft::Arrow { end, .. } => *end = point,
            Draft::Pen { points, .. } | Draft::Mosaic { points, .. } => {
                if points.len() < MAX_POINTS
                    && points
                        .last()
                        .is_none_or(|previous| point_distance(*previous, point) >= 2.0)
                {
                    points.push(point);
                }
            }
        }
        true
    }

    pub fn pointer_up(&mut self, point: POINT, selection: PixelRect) -> bool {
        if self.draft.is_none() {
            return false;
        }
        let _ = self.pointer_move(point, selection);
        let Some(draft) = self.draft.take() else {
            return false;
        };
        let annotation = match draft {
            Draft::Rectangle {
                start,
                end,
                color,
                width,
            } => {
                let rect = points_rect(start, end);
                (rect.width >= 3 && rect.height >= 3).then_some(Annotation::Rectangle {
                    rect,
                    color,
                    width,
                })
            }
            Draft::Ellipse {
                start,
                end,
                color,
                width,
            } => {
                let rect = points_rect(start, end);
                (rect.width >= 3 && rect.height >= 3).then_some(Annotation::Ellipse {
                    rect,
                    color,
                    width,
                })
            }
            Draft::Arrow {
                start,
                end,
                color,
                width,
            } => (point_distance(start, end) >= 5.0).then_some(Annotation::Arrow {
                start,
                end,
                color,
                width,
            }),
            Draft::Pen {
                points,
                color,
                width,
            } => (points.len() >= 2).then_some(Annotation::Pen {
                points,
                color,
                width,
            }),
            Draft::Mosaic { points, size } => {
                (!points.is_empty()).then_some(Annotation::Mosaic { points, size })
            }
        };
        if let Some(annotation) = annotation {
            self.annotations.push(annotation);
        }
        true
    }

    pub fn key_down(&mut self, key: u32) -> bool {
        if !self.enabled {
            return false;
        }
        if key == windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE.0 as u32
            && self.draft.is_some()
        {
            self.draft = None;
            return true;
        }
        false
    }

    pub fn prepare_output(&mut self) {
        self.draft = None;
    }

    pub unsafe fn draw_annotations(&self, dc: HDC, pixels: PixelSource) {
        for annotation in &self.annotations {
            draw_annotation(dc, annotation, pixels);
        }
        if let Some(draft) = &self.draft {
            draw_draft(dc, draft, pixels);
        }
    }

    pub unsafe fn draw_chrome(
        &mut self,
        dc: HDC,
        selection: PixelRect,
        surface_width: i32,
        surface_height: i32,
    ) {
        if !self.chrome_visible() {
            return;
        }
        self.layout(selection, surface_width, surface_height);
        draw_panel(dc, self.toolbar, [246, 247, 249], [35, 38, 43]);
        for (index, button) in BUTTONS.iter().copied().enumerate() {
            let rect = self.button_rect(index);
            let tool_active = self
                .button_tool(button)
                .is_some_and(|tool| tool == self.tool);
            let translated = button == ToolbarButton::Translate && self.translation_applied();
            let hovered = point_in_rect(self.hover, rect);
            let background = if button == ToolbarButton::Complete {
                [28, 181, 113]
            } else if tool_active || translated {
                [219, 238, 255]
            } else if hovered && !self.translation_loading() {
                [229, 232, 237]
            } else {
                [246, 247, 249]
            };
            fill_round_rect(dc, rect, background, 7);
        }
        with_aa_graphics(dc, |graphics| {
            for (index, button) in BUTTONS.iter().copied().enumerate() {
                self.draw_button_icon(graphics, button, self.button_rect(index));
            }
        });
        self.draw_style_panel_background(dc);
        if self.tool != Tool::Select && self.style_panel.right > self.style_panel.left {
            with_aa_graphics(dc, |graphics| self.draw_style_controls(graphics));
        }
    }

    fn activate_button(&mut self, button: ToolbarButton) -> EditorAction {
        if self.translation_loading() {
            return if button == ToolbarButton::Cancel {
                EditorAction::Cancel
            } else {
                EditorAction::Handled
            };
        }
        if let Some(tool) = self.button_tool(button) {
            self.draft = None;
            self.tool = if self.tool == tool {
                Tool::Select
            } else {
                tool
            };
            return EditorAction::Handled;
        }
        match button {
            ToolbarButton::Translate => match self.translation {
                TranslationState::Applied => {
                    self.translation = TranslationState::Idle;
                    EditorAction::CancelTranslation
                }
                TranslationState::Idle => {
                    self.prepare_output();
                    self.tool = Tool::Select;
                    self.translation = TranslationState::Loading { phase: 0 };
                    EditorAction::RequestTranslation
                }
                TranslationState::Loading { .. } => EditorAction::Handled,
            },
            ToolbarButton::Undo => {
                self.draft = None;
                self.annotations.pop();
                EditorAction::Handled
            }
            ToolbarButton::Save => {
                self.prepare_output();
                EditorAction::Finish(EditorIntent::Save)
            }
            ToolbarButton::Cancel => EditorAction::Cancel,
            ToolbarButton::Complete => {
                self.prepare_output();
                EditorAction::Finish(EditorIntent::Copy)
            }
            _ => EditorAction::Handled,
        }
    }

    fn button_tool(&self, button: ToolbarButton) -> Option<Tool> {
        match button {
            ToolbarButton::Rectangle => Some(Tool::Rectangle),
            ToolbarButton::Ellipse => Some(Tool::Ellipse),
            ToolbarButton::Arrow => Some(Tool::Arrow),
            ToolbarButton::Pen => Some(Tool::Pen),
            ToolbarButton::Mosaic => Some(Tool::Mosaic),
            _ => None,
        }
    }

    fn toolbar_button_at(&self, point: POINT) -> Option<ToolbarButton> {
        BUTTONS
            .iter()
            .copied()
            .enumerate()
            .find_map(|(index, button)| {
                point_in_rect(point, self.button_rect(index)).then_some(button)
            })
    }

    fn apply_style_at(&mut self, point: POINT) -> bool {
        if !point_in_rect(point, self.style_panel) || self.tool == Tool::Select {
            return false;
        }
        for index in 0..3 {
            if point_in_rect(point, self.size_rect(index)) {
                self.size_index = index;
                return true;
            }
        }
        if self.tool != Tool::Mosaic {
            for index in 0..COLORS.len() {
                if point_in_rect(point, self.color_rect(index)) {
                    self.color_index = index;
                    return true;
                }
            }
        }
        true
    }

    fn layout(&mut self, selection: PixelRect, width: i32, height: i32) {
        let toolbar_width = TOOLBAR_PADDING * 2
            + BUTTON_WIDTH * BUTTONS.len() as i32
            + BUTTON_GAP * (BUTTONS.len() as i32 - 1);
        let style_width = if self.tool == Tool::Select {
            0
        } else if self.tool == Tool::Mosaic {
            16 + 3 * 42
        } else {
            20 + 3 * 42 + COLORS.len() as i32 * 30
        };
        let stack_height = TOOLBAR_HEIGHT + if style_width > 0 { STYLE_HEIGHT + 8 } else { 0 };
        let x = (selection.x + (selection.width - toolbar_width) / 2)
            .clamp(0, (width - toolbar_width).max(0));
        let below = selection.bottom() + 12;
        let y = if below + stack_height <= height {
            below
        } else if selection.y >= stack_height + 12 {
            selection.y - stack_height - 12
        } else {
            (height - stack_height - 8).max(0)
        };
        self.toolbar = RECT {
            left: x,
            top: y,
            right: x + toolbar_width,
            bottom: y + TOOLBAR_HEIGHT,
        };
        if style_width == 0 {
            self.style_panel = RECT::default();
            return;
        }
        let active_index = BUTTONS
            .iter()
            .position(|button| self.button_tool(*button) == Some(self.tool))
            .unwrap_or(0);
        let active = self.button_rect(active_index);
        let style_x =
            ((active.left + active.right - style_width) / 2).clamp(0, (width - style_width).max(0));
        let style_y = (self.toolbar.bottom + 8).min((height - STYLE_HEIGHT).max(0));
        self.style_panel = RECT {
            left: style_x,
            top: style_y,
            right: style_x + style_width,
            bottom: style_y + STYLE_HEIGHT,
        };
    }

    unsafe fn draw_style_panel_background(&self, dc: HDC) {
        if self.tool == Tool::Select || self.style_panel.right <= self.style_panel.left {
            return;
        }
        draw_panel(dc, self.style_panel, [246, 247, 249], [35, 38, 43]);
    }

    unsafe fn draw_style_controls(&self, graphics: *mut GpGraphics) {
        if self.tool == Tool::Select || self.style_panel.right <= self.style_panel.left {
            return;
        }
        for index in 0..3 {
            let rect = self.size_rect(index);
            if index == self.size_index {
                fill_ellipse(
                    graphics,
                    [219, 238, 255],
                    rect.left + 1,
                    rect.top + 1,
                    rect.right - rect.left - 2,
                    rect.bottom - rect.top - 2,
                );
            }
            let radius = [3, 5, 7][index];
            let center_x = (rect.left + rect.right) / 2;
            let center_y = (rect.top + rect.bottom) / 2;
            fill_ellipse(
                graphics,
                [45, 48, 54],
                center_x - radius,
                center_y - radius,
                radius * 2,
                radius * 2,
            );
        }
        if self.tool != Tool::Mosaic {
            for index in 0..COLORS.len() {
                let rect = self.color_rect(index);
                let diameter = (rect.right - rect.left - 10).min(rect.bottom - rect.top - 2);
                let x = (rect.left + rect.right - diameter) / 2;
                let y = (rect.top + rect.bottom - diameter) / 2;
                if index == self.color_index {
                    draw_ellipse(
                        graphics,
                        [29, 125, 250],
                        2.0,
                        x - 3,
                        y - 3,
                        diameter + 6,
                        diameter + 6,
                    );
                }
                fill_ellipse(graphics, COLORS[index], x, y, diameter, diameter);
                if COLORS[index] == [255, 255, 255] {
                    draw_ellipse(graphics, [180, 184, 190], 1.0, x, y, diameter, diameter);
                }
            }
        }
    }

    unsafe fn draw_button_icon(
        &self,
        graphics: *mut GpGraphics,
        button: ToolbarButton,
        rect: RECT,
    ) {
        let center_x = (rect.left + rect.right) / 2;
        let center_y = (rect.top + rect.bottom) / 2;
        let muted = self.translation_loading()
            && button != ToolbarButton::Translate
            && button != ToolbarButton::Cancel;
        let color = if button == ToolbarButton::Complete {
            [255, 255, 255]
        } else if button == ToolbarButton::Translate {
            [29, 125, 250]
        } else if muted {
            [150, 154, 161]
        } else {
            [45, 48, 54]
        };

        // Keep the generous 44 px hit target, but render a quieter 16 px-class glyph.
        // Scaling the complete vector (including its pen width) keeps every icon visually balanced.
        let mut graphics_state = 0_u32;
        let saved = GdipSaveGraphics(graphics, &mut graphics_state) == GdiPlusOk;
        let mut transform: *mut Matrix = null_mut();
        if saved
            && GdipCreateMatrix2(
                ICON_SCALE,
                0.0,
                0.0,
                ICON_SCALE,
                center_x as f32 * (1.0 - ICON_SCALE),
                center_y as f32 * (1.0 - ICON_SCALE),
                &mut transform,
            ) == GdiPlusOk
            && !transform.is_null()
        {
            let _ = GdipSetWorldTransform(graphics, transform);
        }

        match button {
            ToolbarButton::Rectangle => {
                draw_rectangle(graphics, color, 1.8, center_x - 10, center_y - 7, 20, 14);
            }
            ToolbarButton::Ellipse => {
                draw_ellipse(graphics, color, 1.8, center_x - 10, center_y - 7, 20, 14);
            }
            ToolbarButton::Arrow => {
                draw_line(
                    graphics,
                    color,
                    2.0,
                    center_x - 10,
                    center_y + 7,
                    center_x + 9,
                    center_y - 7,
                );
                draw_line(
                    graphics,
                    color,
                    2.0,
                    center_x + 9,
                    center_y - 7,
                    center_x + 2,
                    center_y - 6,
                );
                draw_line(
                    graphics,
                    color,
                    2.0,
                    center_x + 9,
                    center_y - 7,
                    center_x + 7,
                    center_y,
                );
            }
            ToolbarButton::Pen => {
                draw_line(
                    graphics,
                    color,
                    2.4,
                    center_x - 8,
                    center_y + 7,
                    center_x + 7,
                    center_y - 8,
                );
                draw_line(
                    graphics,
                    color,
                    1.6,
                    center_x + 4,
                    center_y - 9,
                    center_x + 9,
                    center_y - 4,
                );
                draw_line(
                    graphics,
                    color,
                    1.6,
                    center_x - 10,
                    center_y + 9,
                    center_x - 4,
                    center_y + 7,
                );
            }
            ToolbarButton::Mosaic => {
                for row in 0..3 {
                    for column in 0..3 {
                        let offset = if (row + column) % 2 == 0 { 0 } else { 1 };
                        fill_rectangle(
                            graphics,
                            color,
                            center_x - 9 + column * 7,
                            center_y - 9 + row * 7,
                            5 + offset,
                            5 + offset,
                        );
                    }
                }
            }
            ToolbarButton::Translate => match self.translation {
                TranslationState::Loading { phase } => {
                    draw_arc(
                        graphics,
                        color,
                        2.4,
                        center_x - 9,
                        center_y - 9,
                        18,
                        18,
                        f32::from(phase) * 30.0,
                        255.0,
                    );
                }
                _ => {
                    draw_ellipse(graphics, color, 1.7, center_x - 9, center_y - 9, 18, 18);
                    draw_line(
                        graphics,
                        color,
                        1.4,
                        center_x - 8,
                        center_y,
                        center_x + 8,
                        center_y,
                    );
                    draw_arc(
                        graphics,
                        color,
                        1.4,
                        center_x - 5,
                        center_y - 9,
                        10,
                        18,
                        90.0,
                        180.0,
                    );
                    draw_arc(
                        graphics,
                        color,
                        1.4,
                        center_x - 5,
                        center_y - 9,
                        10,
                        18,
                        270.0,
                        180.0,
                    );
                    if self.translation_applied() {
                        draw_line(
                            graphics,
                            color,
                            2.2,
                            center_x + 4,
                            center_y + 6,
                            center_x + 8,
                            center_y + 10,
                        );
                        draw_line(
                            graphics,
                            color,
                            2.2,
                            center_x + 8,
                            center_y + 10,
                            center_x + 14,
                            center_y + 2,
                        );
                    }
                }
            },
            ToolbarButton::Undo => {
                draw_arc(
                    graphics,
                    color,
                    2.0,
                    center_x - 8,
                    center_y - 8,
                    17,
                    17,
                    205.0,
                    250.0,
                );
                draw_line(
                    graphics,
                    color,
                    2.0,
                    center_x - 10,
                    center_y - 2,
                    center_x - 3,
                    center_y - 4,
                );
                draw_line(
                    graphics,
                    color,
                    2.0,
                    center_x - 10,
                    center_y - 2,
                    center_x - 7,
                    center_y - 9,
                );
            }
            ToolbarButton::Save => {
                draw_rectangle(graphics, color, 1.8, center_x - 9, center_y - 10, 18, 20);
                draw_rectangle(graphics, color, 1.5, center_x - 5, center_y - 9, 9, 6);
                draw_rectangle(graphics, color, 1.5, center_x - 5, center_y + 2, 10, 7);
            }
            ToolbarButton::Cancel => {
                draw_line(
                    graphics,
                    color,
                    2.2,
                    center_x - 7,
                    center_y - 7,
                    center_x + 7,
                    center_y + 7,
                );
                draw_line(
                    graphics,
                    color,
                    2.2,
                    center_x + 7,
                    center_y - 7,
                    center_x - 7,
                    center_y + 7,
                );
            }
            ToolbarButton::Complete => {
                draw_line(
                    graphics,
                    color,
                    2.8,
                    center_x - 9,
                    center_y,
                    center_x - 2,
                    center_y + 7,
                );
                draw_line(
                    graphics,
                    color,
                    2.8,
                    center_x - 2,
                    center_y + 7,
                    center_x + 10,
                    center_y - 7,
                );
            }
        }

        if !transform.is_null() {
            let _ = GdipDeleteMatrix(transform);
        }
        if saved {
            let _ = GdipRestoreGraphics(graphics, graphics_state);
        }
    }

    fn button_rect(&self, index: usize) -> RECT {
        let left = self.toolbar.left + TOOLBAR_PADDING + index as i32 * (BUTTON_WIDTH + BUTTON_GAP);
        RECT {
            left,
            top: self.toolbar.top + 5,
            right: left + BUTTON_WIDTH,
            bottom: self.toolbar.bottom - 5,
        }
    }

    fn size_rect(&self, index: usize) -> RECT {
        let left = self.style_panel.left + 10 + index as i32 * 42;
        RECT {
            left,
            top: self.style_panel.top + 5,
            right: left + 36,
            bottom: self.style_panel.bottom - 5,
        }
    }

    fn color_rect(&self, index: usize) -> RECT {
        let left = self.style_panel.left + 10 + 3 * 42 + index as i32 * 30;
        RECT {
            left,
            top: self.style_panel.top + 7,
            right: left + 28,
            bottom: self.style_panel.bottom - 7,
        }
    }

    fn stroke_width(&self) -> i32 {
        [2, 4, 7][self.size_index]
    }

    fn mosaic_size(&self) -> i32 {
        [18, 28, 42][self.size_index]
    }
}

unsafe fn draw_annotation(dc: HDC, annotation: &Annotation, pixels: PixelSource) {
    match annotation {
        Annotation::Rectangle { rect, color, width } => {
            draw_shape(dc, *rect, *color, *width, false)
        }
        Annotation::Ellipse { rect, color, width } => draw_shape(dc, *rect, *color, *width, true),
        Annotation::Arrow {
            start,
            end,
            color,
            width,
        } => draw_arrow(dc, *start, *end, *color, *width),
        Annotation::Pen {
            points,
            color,
            width,
        } => draw_polyline(dc, points, *color, *width),
        Annotation::Mosaic { points, size } => draw_mosaic(dc, points, *size, pixels),
    }
}

unsafe fn draw_draft(dc: HDC, draft: &Draft, pixels: PixelSource) {
    match draft {
        Draft::Rectangle {
            start,
            end,
            color,
            width,
        } => draw_shape(dc, points_rect(*start, *end), *color, *width, false),
        Draft::Ellipse {
            start,
            end,
            color,
            width,
        } => draw_shape(dc, points_rect(*start, *end), *color, *width, true),
        Draft::Arrow {
            start,
            end,
            color,
            width,
        } => draw_arrow(dc, *start, *end, *color, *width),
        Draft::Pen {
            points,
            color,
            width,
        } => draw_polyline(dc, points, *color, *width),
        Draft::Mosaic { points, size } => draw_mosaic(dc, points, *size, pixels),
    }
}

unsafe fn draw_shape(dc: HDC, rect: PixelRect, color: [u8; 3], width: i32, ellipse: bool) {
    if rect.width < 1 || rect.height < 1 {
        return;
    }
    with_aa_graphics(dc, |graphics| {
        if ellipse {
            draw_ellipse(
                graphics,
                color,
                width as f32,
                rect.x,
                rect.y,
                rect.width,
                rect.height,
            );
        } else {
            draw_rectangle(
                graphics,
                color,
                width as f32,
                rect.x,
                rect.y,
                rect.width,
                rect.height,
            );
        }
    });
}

unsafe fn draw_polyline(dc: HDC, points: &[POINT], color: [u8; 3], width: i32) {
    if points.len() < 2 {
        return;
    }
    with_aa_graphics(dc, |graphics| {
        with_pen(graphics, color, width as f32, |pen| {
            let points: Vec<GpPoint> = points
                .iter()
                .map(|point| GpPoint {
                    X: point.x,
                    Y: point.y,
                })
                .collect();
            let _ = GdipDrawLinesI(graphics, pen, points.as_ptr(), points.len() as i32);
        });
    });
}

unsafe fn draw_arrow(dc: HDC, start: POINT, end: POINT, color: [u8; 3], width: i32) {
    let dx = f64::from(end.x - start.x);
    let dy = f64::from(end.y - start.y);
    let length = (dx * dx + dy * dy).sqrt();
    if length < 2.0 {
        return;
    }
    let head = (12.0 + f64::from(width) * 2.0).min(length * 0.45);
    let ux = dx / length;
    let uy = dy / length;
    let px = -uy;
    let py = ux;
    with_aa_graphics(dc, |graphics| {
        with_pen(graphics, color, width as f32, |pen| {
            let _ = GdipDrawLineI(graphics, pen, start.x, start.y, end.x, end.y);
            for side in [-1.0_f64, 1.0] {
                let point = POINT {
                    x: (f64::from(end.x) - ux * head + px * head * 0.48 * side).round() as i32,
                    y: (f64::from(end.y) - uy * head + py * head * 0.48 * side).round() as i32,
                };
                let _ = GdipDrawLineI(graphics, pen, end.x, end.y, point.x, point.y);
            }
        });
    });
}

unsafe fn draw_mosaic(dc: HDC, points: &[POINT], size: i32, pixels: PixelSource) {
    for rect in mosaic_cells(points, size, pixels.width, pixels.height) {
        let average = pixels.average(rect);
        let brush = CreateSolidBrush(rgb(average));
        if brush.is_invalid() {
            continue;
        }
        let target = RECT {
            left: rect.x,
            top: rect.y,
            right: rect.right(),
            bottom: rect.bottom(),
        };
        let _ = FillRect(dc, &target, brush);
        let _ = DeleteObject(HGDIOBJ(brush.0));
    }
}

fn mosaic_cells(points: &[POINT], brush_size: i32, width: i32, height: i32) -> Vec<PixelRect> {
    if points.is_empty() || width < 1 || height < 1 {
        return Vec::new();
    }
    let brush_size = brush_size.max(8);
    let block = (brush_size / 4).max(4);
    let radius = brush_size as f64 / 2.0;
    let sample_step = (block as f64 / 2.0).max(1.0);
    let mut cells = HashSet::<(i32, i32)>::new();
    let mut add_stamp = |x: f64, y: f64| {
        let min_column = ((x - radius) as i32).div_euclid(block) - 1;
        let max_column = ((x + radius) as i32).div_euclid(block) + 1;
        let min_row = ((y - radius) as i32).div_euclid(block) - 1;
        let max_row = ((y + radius) as i32).div_euclid(block) + 1;
        for row in min_row..=max_row {
            for column in min_column..=max_column {
                let center_x = f64::from(column * block) + f64::from(block) / 2.0;
                let center_y = f64::from(row * block) + f64::from(block) / 2.0;
                let dx = center_x - x;
                let dy = center_y - y;
                let allowance = radius + f64::from(block) * 0.72;
                if dx * dx + dy * dy <= allowance * allowance {
                    let cell_x = column * block;
                    let cell_y = row * block;
                    if cell_x < width && cell_y < height && cell_x + block > 0 && cell_y + block > 0
                    {
                        cells.insert((cell_x, cell_y));
                    }
                }
            }
        }
    };
    if points.len() == 1 {
        add_stamp(f64::from(points[0].x), f64::from(points[0].y));
    } else {
        for pair in points.windows(2) {
            let start = pair[0];
            let end = pair[1];
            let dx = f64::from(end.x - start.x);
            let dy = f64::from(end.y - start.y);
            let distance = (dx * dx + dy * dy).sqrt();
            let steps = (distance / sample_step).ceil().max(1.0) as usize;
            for step in 0..=steps {
                let ratio = step as f64 / steps as f64;
                add_stamp(
                    f64::from(start.x) + dx * ratio,
                    f64::from(start.y) + dy * ratio,
                );
            }
        }
    }
    let mut result: Vec<_> = cells
        .into_iter()
        .map(|(x, y)| {
            PixelRect {
                x,
                y,
                width: block,
                height: block,
            }
            .normalized(width, height)
        })
        .filter(|rect| rect.width > 0 && rect.height > 0)
        .collect();
    result.sort_by_key(|rect| (rect.y, rect.x));
    result
}

unsafe fn draw_panel(dc: HDC, rect: RECT, fill: [u8; 3], shadow: [u8; 3]) {
    let shadow_brush = CreateSolidBrush(rgb(shadow));
    let old = SelectObject(dc, HGDIOBJ(shadow_brush.0));
    let _ = RoundRect(
        dc,
        rect.left + 2,
        rect.top + 3,
        rect.right + 3,
        rect.bottom + 4,
        PANEL_RADIUS * 2,
        PANEL_RADIUS * 2,
    );
    let fill_brush = CreateSolidBrush(rgb(fill));
    let _ = SelectObject(dc, HGDIOBJ(fill_brush.0));
    let _ = RoundRect(
        dc,
        rect.left,
        rect.top,
        rect.right,
        rect.bottom,
        PANEL_RADIUS * 2,
        PANEL_RADIUS * 2,
    );
    let _ = SelectObject(dc, old);
    let _ = DeleteObject(HGDIOBJ(fill_brush.0));
    let _ = DeleteObject(HGDIOBJ(shadow_brush.0));
}

unsafe fn fill_round_rect(dc: HDC, rect: RECT, fill: [u8; 3], radius: i32) {
    let brush = CreateSolidBrush(rgb(fill));
    let previous = SelectObject(dc, HGDIOBJ(brush.0));
    let _ = RoundRect(
        dc,
        rect.left,
        rect.top,
        rect.right,
        rect.bottom,
        radius * 2,
        radius * 2,
    );
    let _ = SelectObject(dc, previous);
    let _ = DeleteObject(HGDIOBJ(brush.0));
}

unsafe fn with_aa_graphics<F>(dc: HDC, draw: F)
where
    F: FnOnce(*mut GpGraphics),
{
    let mut graphics: *mut GpGraphics = null_mut();
    if GdipCreateFromHDC(dc, &mut graphics) != GdiPlusOk || graphics.is_null() {
        return;
    }
    let _ = GdipSetSmoothingMode(graphics, SmoothingModeAntiAlias8x8);
    draw(graphics);
    let _ = GdipDeleteGraphics(graphics);
}

unsafe fn with_pen<F>(_graphics: *mut GpGraphics, color: [u8; 3], width: f32, draw: F)
where
    F: FnOnce(*mut GpPen),
{
    let mut pen: *mut GpPen = null_mut();
    if GdipCreatePen1(argb(color), width, UnitPixel, &mut pen) != GdiPlusOk || pen.is_null() {
        return;
    }
    let _ = GdipSetPenStartCap(pen, LineCapRound);
    let _ = GdipSetPenEndCap(pen, LineCapRound);
    let _ = GdipSetPenLineJoin(pen, LineJoinRound);
    draw(pen);
    let _ = GdipDeletePen(pen);
}

unsafe fn with_brush<F>(color: [u8; 3], draw: F)
where
    F: FnOnce(*mut GpBrush),
{
    let mut brush: *mut GpSolidFill = null_mut();
    if GdipCreateSolidFill(argb(color), &mut brush) != GdiPlusOk || brush.is_null() {
        return;
    }
    draw(brush.cast());
    let _ = GdipDeleteBrush(brush.cast());
}

unsafe fn draw_line(
    graphics: *mut GpGraphics,
    color: [u8; 3],
    width: f32,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
) {
    with_pen(graphics, color, width, |pen| {
        let _ = GdipDrawLineI(graphics, pen, x1, y1, x2, y2);
    });
}

unsafe fn draw_rectangle(
    graphics: *mut GpGraphics,
    color: [u8; 3],
    width: f32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) {
    with_pen(graphics, color, width, |pen| {
        let _ = GdipDrawRectangleI(graphics, pen, x, y, w, h);
    });
}

unsafe fn draw_ellipse(
    graphics: *mut GpGraphics,
    color: [u8; 3],
    width: f32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) {
    with_pen(graphics, color, width, |pen| {
        let _ = GdipDrawEllipseI(graphics, pen, x, y, w, h);
    });
}

unsafe fn draw_arc(
    graphics: *mut GpGraphics,
    color: [u8; 3],
    width: f32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    start: f32,
    sweep: f32,
) {
    with_pen(graphics, color, width, |pen| {
        let _ = GdipDrawArcI(graphics, pen, x, y, w, h, start, sweep);
    });
}

unsafe fn fill_ellipse(graphics: *mut GpGraphics, color: [u8; 3], x: i32, y: i32, w: i32, h: i32) {
    with_brush(color, |brush| {
        let _ = GdipFillEllipseI(graphics, brush, x, y, w, h);
    });
}

unsafe fn fill_rectangle(
    graphics: *mut GpGraphics,
    color: [u8; 3],
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) {
    with_brush(color, |brush| {
        let _ = GdipFillRectangleI(graphics, brush, x, y, w, h);
    });
}

#[allow(dead_code)]
unsafe fn fill_polygon(graphics: *mut GpGraphics, color: [u8; 3], points: &[GpPoint]) {
    if points.len() < 3 {
        return;
    }
    with_brush(color, |brush| {
        let _ = GdipFillPolygonI(
            graphics,
            brush,
            points.as_ptr(),
            points.len() as i32,
            FillModeAlternate,
        );
    });
}

fn points_rect(start: POINT, end: POINT) -> PixelRect {
    PixelRect {
        x: start.x.min(end.x),
        y: start.y.min(end.y),
        width: (start.x - end.x).abs().max(1),
        height: (start.y - end.y).abs().max(1),
    }
}

fn clamp_point(point: POINT, rect: PixelRect) -> POINT {
    POINT {
        x: point
            .x
            .clamp(rect.x, rect.right().saturating_sub(1).max(rect.x)),
        y: point
            .y
            .clamp(rect.y, rect.bottom().saturating_sub(1).max(rect.y)),
    }
}

fn point_distance(left: POINT, right: POINT) -> f64 {
    let dx = f64::from(right.x - left.x);
    let dy = f64::from(right.y - left.y);
    (dx * dx + dy * dy).sqrt()
}

fn point_in_rect(point: POINT, rect: RECT) -> bool {
    rect.right > rect.left
        && rect.bottom > rect.top
        && point.x >= rect.left
        && point.x < rect.right
        && point.y >= rect.top
        && point.y < rect.bottom
}

fn rgb(value: [u8; 3]) -> COLORREF {
    COLORREF(u32::from(value[0]) | (u32::from(value[1]) << 8) | (u32::from(value[2]) << 16))
}

fn argb(value: [u8; 3]) -> u32 {
    0xFF00_0000 | (u32::from(value[0]) << 16) | (u32::from(value[1]) << 8) | u32::from(value[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_reset_clears_annotations_and_hides_chrome() {
        let mut editor = EditorState::default();
        editor.reset(true);
        assert!(editor.enabled());
        assert!(!editor.chrome_visible());
        assert_eq!(editor.annotation_count(), 0);
        editor.reset(false);
        assert!(!editor.enabled());
    }

    #[test]
    fn point_rect_normalizes_drag_direction() {
        assert_eq!(
            points_rect(POINT { x: 20, y: 40 }, POINT { x: 5, y: 10 }),
            PixelRect {
                x: 5,
                y: 10,
                width: 15,
                height: 30
            }
        );
    }

    #[test]
    fn editor_intents_are_stable_protocol_values() {
        assert_eq!(EditorIntent::Save.as_str(), "save");
        assert_eq!(EditorIntent::Copy.as_str(), "copy");
    }

    #[test]
    fn mosaic_interpolates_fast_pointer_segments_without_holes() {
        let cells = mosaic_cells(
            &[POINT { x: 20, y: 50 }, POINT { x: 220, y: 50 }],
            28,
            300,
            100,
        );
        for x in 20..=220 {
            assert!(cells.iter().any(|rect| {
                x >= rect.x && x < rect.right() && 50 >= rect.y && 50 < rect.bottom()
            }));
        }
    }
}
