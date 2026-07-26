use anyhow::{bail, Context, Result};
use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder, RgbaImage};
use serde::Deserialize;
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::null_mut;
use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HANDLE, HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, DrawTextW, GetDC,
    ReleaseDC, SelectObject, SetBkMode, SetTextColor, ANTIALIASED_QUALITY, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS,
    DT_CALCRECT, DT_CENTER, DT_EDITCONTROL, DT_NOPREFIX, DT_WORDBREAK, FF_DONTCARE, HBITMAP, HDC,
    HGDIOBJ, OUT_DEFAULT_PRECIS, TRANSPARENT,
};

const MAX_PIXELS: u64 = 100_000_000;
const MAX_REGIONS: usize = 256;
const MIN_FONT_SIZE: i32 = 8;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl RenderRect {
    fn right(self) -> i32 {
        self.x.saturating_add(self.width)
    }

    fn bottom(self) -> i32 {
        self.y.saturating_add(self.height)
    }

    fn expanded(self, amount: i32, width: i32, height: i32) -> Self {
        let left = self.x.saturating_sub(amount).clamp(0, width);
        let top = self.y.saturating_sub(amount).clamp(0, height);
        let right = self.right().saturating_add(amount).clamp(left, width);
        let bottom = self.bottom().saturating_add(amount).clamp(top, height);
        Self {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRegion {
    source_text: String,
    translated_text: String,
    erase_rects: Vec<RenderRect>,
    layout_rect: RenderRect,
    font_size: i32,
    bold: bool,
    align: String,
    vertical_align: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSpec {
    width: u32,
    height: u32,
    regions: Vec<RenderRegion>,
}

pub struct RenderOutput {
    pub bytes: Vec<u8>,
    pub rendered_regions: usize,
    pub skipped_regions: usize,
}

#[derive(Clone)]
struct PreparedRegion {
    region: RenderRegion,
    foreground: [u8; 3],
}

pub fn render(input_png: &[u8], spec: RenderSpec) -> Result<RenderOutput> {
    validate_spec(&spec)?;
    let decoded = image::load_from_memory(input_png)
        .context("decode source image for direct translation")?
        .to_rgba8();
    if decoded.width() != spec.width || decoded.height() != spec.height {
        bail!("source image dimensions do not match render specification");
    }
    let original = decoded.clone();
    let mut erased = decoded;
    let width = spec.width as i32;
    let height = spec.height as i32;
    let mut prepared = Vec::with_capacity(spec.regions.len());
    let mut skipped = 0usize;

    for region in spec.regions {
        let analyses: Vec<BackgroundAnalysis> = region
            .erase_rects
            .iter()
            .map(|rect| analyze_background(&original, rect.expanded(2, width, height)))
            .collect();
        if analyses.iter().any(|analysis| analysis.complex) {
            skipped += 1;
            continue;
        }
        let background = average_colors(analyses.iter().map(|analysis| analysis.color));
        let foreground = estimate_foreground(&original, &region.erase_rects, background);
        for (rect, analysis) in region.erase_rects.iter().zip(analyses.iter()) {
            erase_text_rect(
                &mut erased,
                &original,
                rect.expanded(2, width, height),
                analysis,
            );
        }
        prepared.push(PreparedRegion { region, foreground });
    }

    let mut surface = DibSurface::new(spec.width as i32, spec.height as i32)?;
    surface.copy_rgba(&erased)?;
    for item in &prepared {
        draw_region(surface.dc, &item.region, item.foreground)?;
    }
    let rgba = surface.to_rgba()?;
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(&rgba, spec.width, spec.height, ColorType::Rgba8.into())
        .context("encode translated image")?;
    Ok(RenderOutput {
        bytes: png,
        rendered_regions: prepared.len(),
        skipped_regions: skipped,
    })
}

fn validate_spec(spec: &RenderSpec) -> Result<()> {
    let pixels = u64::from(spec.width)
        .checked_mul(u64::from(spec.height))
        .context("translated image dimensions overflow")?;
    if spec.width < 1 || spec.height < 1 || pixels > MAX_PIXELS {
        bail!("translated image dimensions are invalid");
    }
    if spec.regions.is_empty() || spec.regions.len() > MAX_REGIONS {
        bail!("translated image region count is invalid");
    }
    let mut total_text = 0usize;
    for region in &spec.regions {
        total_text = total_text
            .checked_add(region.source_text.len())
            .and_then(|value| value.checked_add(region.translated_text.len()))
            .context("translated image text length overflow")?;
        if region.source_text.is_empty()
            || region.translated_text.is_empty()
            || region.erase_rects.is_empty()
            || region.erase_rects.len() > 64
            || !(MIN_FONT_SIZE..=128).contains(&region.font_size)
            || !matches!(region.align.as_str(), "left" | "center" | "right")
            || !matches!(region.vertical_align.as_str(), "top" | "center")
        {
            bail!("translated image region is invalid");
        }
        validate_rect(region.layout_rect, spec.width as i32, spec.height as i32)?;
        for rect in &region.erase_rects {
            validate_rect(*rect, spec.width as i32, spec.height as i32)?;
        }
    }
    if total_text > 512 * 1024 {
        bail!("translated image text exceeds size limit");
    }
    Ok(())
}

fn validate_rect(rect: RenderRect, width: i32, height: i32) -> Result<()> {
    if rect.x < 0
        || rect.y < 0
        || rect.width < 1
        || rect.height < 1
        || rect.right() > width
        || rect.bottom() > height
    {
        bail!("translated image rectangle is outside the image");
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct BackgroundAnalysis {
    color: [u8; 3],
    mean_distance: f32,
    complex: bool,
}

fn analyze_background(image: &RgbaImage, rect: RenderRect) -> BackgroundAnalysis {
    let mut samples = Vec::<[u8; 3]>::new();
    let width = image.width() as i32;
    let height = image.height() as i32;
    let left = (rect.x - 2).max(0);
    let right = (rect.right() + 1).min(width - 1);
    let top = (rect.y - 2).max(0);
    let bottom = (rect.bottom() + 1).min(height - 1);
    for x in left..=right {
        for y in [top, bottom] {
            samples.push(rgb(image, x, y));
        }
    }
    for y in top..=bottom {
        for x in [left, right] {
            samples.push(rgb(image, x, y));
        }
    }
    if samples.is_empty() {
        return BackgroundAnalysis {
            color: [255, 255, 255],
            mean_distance: 0.0,
            complex: false,
        };
    }
    let mut buckets: HashMap<u16, (usize, u64, u64, u64)> = HashMap::new();
    for sample in &samples {
        let key = quantized_key(*sample);
        let entry = buckets.entry(key).or_default();
        entry.0 += 1;
        entry.1 += u64::from(sample[0]);
        entry.2 += u64::from(sample[1]);
        entry.3 += u64::from(sample[2]);
    }
    let (_, (count, red, green, blue)) = buckets
        .into_iter()
        .max_by_key(|(_, value)| value.0)
        .unwrap_or((0, (1, 255, 255, 255)));
    let color = [
        (red / count as u64) as u8,
        (green / count as u64) as u8,
        (blue / count as u64) as u8,
    ];
    let mean_distance = samples
        .iter()
        .map(|sample| color_distance(*sample, color))
        .sum::<f32>()
        / samples.len() as f32;
    let dominant_share = count as f32 / samples.len() as f32;
    BackgroundAnalysis {
        color,
        mean_distance,
        complex: dominant_share < 0.12 && mean_distance > 58.0,
    }
}

fn erase_text_rect(
    target: &mut RgbaImage,
    original: &RgbaImage,
    rect: RenderRect,
    analysis: &BackgroundAnalysis,
) {
    if analysis.mean_distance <= 20.0 {
        for y in rect.y..rect.bottom() {
            for x in rect.x..rect.right() {
                target.put_pixel(
                    x as u32,
                    y as u32,
                    image::Rgba([analysis.color[0], analysis.color[1], analysis.color[2], 255]),
                );
            }
        }
        return;
    }

    let image_width = original.width() as i32;
    let image_height = original.height() as i32;
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            let left = rgb(original, (rect.x - 1).max(0), y.clamp(0, image_height - 1));
            let right = rgb(
                original,
                rect.right().min(image_width - 1),
                y.clamp(0, image_height - 1),
            );
            let top = rgb(original, x.clamp(0, image_width - 1), (rect.y - 1).max(0));
            let bottom = rgb(
                original,
                x.clamp(0, image_width - 1),
                rect.bottom().min(image_height - 1),
            );
            let horizontal = if rect.width <= 1 {
                left
            } else {
                mix(left, right, (x - rect.x) as f32 / (rect.width - 1) as f32)
            };
            let vertical = if rect.height <= 1 {
                top
            } else {
                mix(top, bottom, (y - rect.y) as f32 / (rect.height - 1) as f32)
            };
            let value = average_colors([horizontal, vertical]);
            target.put_pixel(
                x as u32,
                y as u32,
                image::Rgba([value[0], value[1], value[2], 255]),
            );
        }
    }
}

fn estimate_foreground(image: &RgbaImage, rects: &[RenderRect], background: [u8; 3]) -> [u8; 3] {
    let mut candidates = Vec::<[u8; 3]>::new();
    for rect in rects {
        let step = if rect.width.saturating_mul(rect.height) > 200_000 {
            2
        } else {
            1
        };
        for y in (rect.y..rect.bottom()).step_by(step) {
            for x in (rect.x..rect.right()).step_by(step) {
                let value = rgb(image, x, y);
                if color_distance(value, background) > 26.0 {
                    candidates.push(value);
                }
            }
        }
    }
    if candidates.len() < 3 {
        return if luminance(background) > 145.0 {
            [30, 35, 40]
        } else {
            [240, 240, 240]
        };
    }
    candidates.sort_by(|left, right| luminance(*left).total_cmp(&luminance(*right)));
    let take = (candidates.len() / 3).max(1);
    if luminance(background) > 145.0 {
        average_colors(candidates.into_iter().take(take))
    } else {
        average_colors(candidates.into_iter().rev().take(take))
    }
}

fn rgb(image: &RgbaImage, x: i32, y: i32) -> [u8; 3] {
    let pixel = image.get_pixel(x as u32, y as u32).0;
    [pixel[0], pixel[1], pixel[2]]
}

fn quantized_key(value: [u8; 3]) -> u16 {
    (u16::from(value[0] >> 3) << 10) | (u16::from(value[1] >> 3) << 5) | u16::from(value[2] >> 3)
}

fn color_distance(left: [u8; 3], right: [u8; 3]) -> f32 {
    let red = f32::from(left[0]) - f32::from(right[0]);
    let green = f32::from(left[1]) - f32::from(right[1]);
    let blue = f32::from(left[2]) - f32::from(right[2]);
    (red * red + green * green + blue * blue).sqrt()
}

fn luminance(value: [u8; 3]) -> f32 {
    f32::from(value[0]) * 0.2126 + f32::from(value[1]) * 0.7152 + f32::from(value[2]) * 0.0722
}

fn mix(left: [u8; 3], right: [u8; 3], ratio: f32) -> [u8; 3] {
    let ratio = ratio.clamp(0.0, 1.0);
    [0, 1, 2].map(|index| {
        (f32::from(left[index]) * (1.0 - ratio) + f32::from(right[index]) * ratio)
            .round()
            .clamp(0.0, 255.0) as u8
    })
}

fn average_colors(values: impl IntoIterator<Item = [u8; 3]>) -> [u8; 3] {
    let mut count = 0u64;
    let mut total = [0u64; 3];
    for value in values {
        count += 1;
        for index in 0..3 {
            total[index] += u64::from(value[index]);
        }
    }
    if count == 0 {
        return [255, 255, 255];
    }
    [
        (total[0] / count) as u8,
        (total[1] / count) as u8,
        (total[2] / count) as u8,
    ]
}

fn draw_region(dc: HDC, region: &RenderRegion, foreground: [u8; 3]) -> Result<()> {
    let width = region.layout_rect.width.max(1);
    let height = region.layout_rect.height.max(1);
    let mut chosen_size = MIN_FONT_SIZE;
    let mut measured_height = height;
    for size in (MIN_FONT_SIZE..=region.font_size).rev() {
        let font = create_font(size, region.bold, contains_cjk(&region.translated_text))?;
        let previous = unsafe { SelectObject(dc, HGDIOBJ(font.0)) };
        if previous.0 == 0 || previous.0 == -1 {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(font.0));
            }
            bail!("select translated image font failed");
        }
        let measured = measure_text(dc, &region.translated_text, width);
        unsafe {
            let _ = SelectObject(dc, previous);
            let _ = DeleteObject(HGDIOBJ(font.0));
        }
        if measured.0 <= width + 1 && measured.1 <= height {
            chosen_size = size;
            measured_height = measured.1;
            break;
        }
    }

    let font = create_font(
        chosen_size,
        region.bold,
        contains_cjk(&region.translated_text),
    )?;
    let previous = unsafe { SelectObject(dc, HGDIOBJ(font.0)) };
    if previous.0 == 0 || previous.0 == -1 {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(font.0));
        }
        bail!("select translated image font failed");
    }
    unsafe {
        let _ = SetBkMode(dc, TRANSPARENT);
        let _ = SetTextColor(dc, color(foreground));
    }
    let mut top = region.layout_rect.y;
    if region.vertical_align == "center" && measured_height < height {
        top += (height - measured_height) / 2;
    }
    let mut rect = RECT {
        left: region.layout_rect.x,
        top,
        right: region.layout_rect.right(),
        bottom: region.layout_rect.bottom(),
    };
    let mut text: Vec<u16> = region.translated_text.encode_utf16().collect();
    let mut flags = DT_WORDBREAK | DT_EDITCONTROL | DT_NOPREFIX;
    if region.align == "center" {
        flags |= DT_CENTER;
    }
    unsafe {
        let _ = DrawTextW(dc, &mut text, &mut rect, flags);
        let _ = SelectObject(dc, previous);
        let _ = DeleteObject(HGDIOBJ(font.0));
    }
    Ok(())
}

fn measure_text(dc: HDC, text: &str, width: i32) -> (i32, i32) {
    let mut value: Vec<u16> = text.encode_utf16().collect();
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: width,
        bottom: 0,
    };
    unsafe {
        let _ = DrawTextW(
            dc,
            &mut value,
            &mut rect,
            DT_CALCRECT | DT_WORDBREAK | DT_EDITCONTROL | DT_NOPREFIX,
        );
    }
    (
        (rect.right - rect.left).max(1),
        (rect.bottom - rect.top).max(1),
    )
}

fn create_font(size: i32, bold: bool, cjk: bool) -> Result<windows::Win32::Graphics::Gdi::HFONT> {
    let face = if cjk {
        w!("Microsoft YaHei UI")
    } else {
        w!("Segoe UI")
    };
    let font = unsafe {
        CreateFontW(
            -size,
            0,
            0,
            0,
            if bold { 600 } else { 400 },
            0,
            0,
            0,
            DEFAULT_CHARSET.0 as u32,
            OUT_DEFAULT_PRECIS.0 as u32,
            CLIP_DEFAULT_PRECIS.0 as u32,
            ANTIALIASED_QUALITY.0 as u32,
            (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32,
            face,
        )
    };
    if font.is_invalid() {
        bail!("create translated image font failed");
    }
    Ok(font)
}

fn contains_cjk(value: &str) -> bool {
    value.chars().any(|character| {
        matches!(
            character as u32,
            0x3040..=0x30ff | 0x3400..=0x9fff | 0xac00..=0xd7af
        )
    })
}

fn color(value: [u8; 3]) -> COLORREF {
    COLORREF(u32::from(value[0]) | (u32::from(value[1]) << 8) | (u32::from(value[2]) << 16))
}

struct DibSurface {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    width: i32,
    height: i32,
}

impl DibSurface {
    fn new(width: i32, height: i32) -> Result<Self> {
        unsafe {
            let screen_dc = GetDC(HWND(0));
            if screen_dc.is_invalid() {
                bail!("translated image GetDC failed");
            }
            let created = (|| -> Result<Self> {
                let dc = CreateCompatibleDC(screen_dc);
                if dc.is_invalid() {
                    bail!("translated image CreateCompatibleDC failed");
                }
                let mut info = BITMAPINFO::default();
                info.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                };
                let mut bits: *mut c_void = null_mut();
                let bitmap = match CreateDIBSection(
                    screen_dc,
                    &info,
                    DIB_RGB_COLORS,
                    &mut bits,
                    HANDLE(0),
                    0,
                ) {
                    Ok(bitmap) => bitmap,
                    Err(error) => {
                        let _ = DeleteDC(dc);
                        return Err(error).context("create translated image DIB");
                    }
                };
                if bits.is_null() {
                    let _ = DeleteObject(HGDIOBJ(bitmap.0));
                    let _ = DeleteDC(dc);
                    bail!("translated image DIB returned no pixel buffer");
                }
                let previous = SelectObject(dc, HGDIOBJ(bitmap.0));
                if previous.0 == 0 || previous.0 == -1 {
                    let _ = DeleteObject(HGDIOBJ(bitmap.0));
                    let _ = DeleteDC(dc);
                    bail!("select translated image DIB failed");
                }
                Ok(Self {
                    dc,
                    bitmap,
                    previous,
                    bits: bits.cast(),
                    width,
                    height,
                })
            })();
            let _ = ReleaseDC(HWND(0), screen_dc);
            created
        }
    }

    fn copy_rgba(&mut self, image: &RgbaImage) -> Result<()> {
        let expected = self
            .width
            .checked_mul(self.height)
            .and_then(|value| value.checked_mul(4))
            .context("translated image pixel size overflow")? as usize;
        if image.as_raw().len() != expected {
            bail!("translated image pixel buffer length is invalid");
        }
        let target = unsafe { std::slice::from_raw_parts_mut(self.bits, expected) };
        for (source, destination) in image
            .as_raw()
            .chunks_exact(4)
            .zip(target.chunks_exact_mut(4))
        {
            destination[0] = source[2];
            destination[1] = source[1];
            destination[2] = source[0];
            destination[3] = 255;
        }
        Ok(())
    }

    fn to_rgba(&self) -> Result<Vec<u8>> {
        let length = self
            .width
            .checked_mul(self.height)
            .and_then(|value| value.checked_mul(4))
            .context("translated image pixel size overflow")? as usize;
        let source = unsafe { std::slice::from_raw_parts(self.bits, length) };
        let mut rgba = vec![0u8; length];
        for (source, destination) in source.chunks_exact(4).zip(rgba.chunks_exact_mut(4)) {
            destination[0] = source[2];
            destination[1] = source[1];
            destination[2] = source[0];
            destination[3] = 255;
        }
        Ok(rgba)
    }
}

impl Drop for DibSurface {
    fn drop(&mut self) {
        unsafe {
            let _ = SelectObject(self.dc, self.previous);
            let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            let _ = DeleteDC(self.dc);
        }
    }
}
