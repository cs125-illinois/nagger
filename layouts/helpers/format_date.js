const moment = require('moment-timezone')
const common_formats = {
  normal: "M/D/YYYY",
  slides: "ddd M.D.YYYY",
  full: "M/D/YYYY [@] HH:mm [CDT]",
  name: "DD MMM YYYY",
  proposal: "M/YYYY",
  blog: "DD MMM YYYY [at] HH:mm [CDT]",
  xml: "ddd, DD MMM YYYY HH:mm:ss ZZ",
  file: "YYYY-MM-DD"
}

module.exports = (datetime, format, utc) => {
  format = common_formats[format] || format
  if (utc === undefined) {
    utc = true
  }
  if (utc) {
    return moment.utc(datetime).format(format);
  } else {
    return moment.tz(datetime, "America/Chicago").format(format);
  }
}
