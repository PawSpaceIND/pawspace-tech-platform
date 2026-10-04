export type TrainingAttendance = Record<string, unknown>;
export function trainingAttendanceReady(attendance: TrainingAttendance | undefined) {
  return Boolean(attendance && ['parent', 'trainer_led'].includes(String(attendance.mode)) && attendance.safeAreaConfirmed === true && (attendance.mode !== 'parent' || attendance.parentOrCaretakerConfirmed === true));
}
export function trainingBeforeCaptured(assets: Array<{purpose:string;access_status:string;review_status?:string;retention_status?:string;scan_status?:string}>) {
  return assets.some(asset => asset.purpose === 'before_service' && ['quarantined','ready'].includes(asset.access_status) && (!asset.retention_status || asset.retention_status === 'active') && asset.review_status !== 'rejected' && asset.scan_status !== 'infected');
}
