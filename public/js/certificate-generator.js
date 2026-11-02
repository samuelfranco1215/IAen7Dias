/**
 * Generador de Certificados en PDF para "IA en 7 Días"
 * Utiliza jsPDF para crear un documento vectorial nítido, elegante y descargable al instante.
 */

window.CertificateGenerator = {
  _logoDataUrl: null,

  _preloadLogo: function() {
    if (this._logoDataUrl) return Promise.resolve(this._logoDataUrl);
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || 586;
          canvas.height = img.naturalHeight || 520;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          this._logoDataUrl = canvas.toDataURL('image/png');
          resolve(this._logoDataUrl);
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = 'images/logo-crop.png';
    });
  },

  /**
   * Genera y descarga el certificado en formato PDF
   * @param {Object} student - Objeto alumno con name, certificateCode, certificateIssuedAt
   */
  downloadPDF: async function(student) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      alert("Cargando la librería de generación de PDF. Por favor intenta de nuevo en unos segundos.");
      return;
    }

    const logoData = await this._preloadLogo();

    const { jsPDF } = window.jspdf;
    // Formato horizontal A4 (297mm ancho x 210mm alto)
    const doc = new jsPDF({
      orientation: 'landscape',
      unit: 'mm',
      format: 'a4'
    });

    const studentName = student.name || 'Estudiante Destacado';
    const docInfo = student.docNumber ? `${student.docType || 'CC'} ${student.docNumber}` : '';
    const certCode = student.certificateCode || ('IA7D-' + Math.random().toString(36).substring(2, 8).toUpperCase());
    
    // Formatear fecha en español
    const issueDate = student.certificateIssuedAt ? new Date(student.certificateIssuedAt) : new Date();
    const formattedDate = issueDate.toLocaleDateString('es-CO', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

    const width = 297;
    const height = 210;

    // 1. Fondo marfil cálido y sobrio (#FAF8F5)
    doc.setFillColor(250, 248, 245);
    doc.rect(0, 0, width, height, 'F');

    // 2. Marco exterior sobrio carbón (#1C1917)
    doc.setDrawColor(28, 25, 23);
    doc.setLineWidth(2.2);
    doc.rect(12, 12, width - 24, height - 24);

    // 3. Marco interior fino verde azulado (#0F766E)
    doc.setDrawColor(15, 118, 110);
    doc.setLineWidth(0.6);
    doc.rect(15.5, 15.5, width - 31, height - 31);

    // 4. Línea superior de acento (#0F766E)
    doc.setFillColor(15, 118, 110);
    doc.rect(15.5, 15.5, width - 31, 3, 'F');

    // 5. Logo Oficial y Encabezado
    if (logoData) {
      try {
        doc.addImage(logoData, 'PNG', (width / 2) - 12, 23, 24, 21.3);
      } catch (e) {
        console.warn("No se pudo incrustar logo en PDF:", e);
      }
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(87, 83, 78);
    doc.text("IA EN 7 DÍAS • PROGRAMA DE FORMACIÓN PRÁCTICA", width / 2, 50, { align: 'center' });

    // 6. Título Principal
    doc.setFont("times", "bold");
    doc.setFontSize(26);
    doc.setTextColor(28, 25, 23);
    doc.text("CERTIFICADO DE FINALIZACIÓN", width / 2, 62, { align: 'center' });

    // Línea divisoria sobria
    doc.setDrawColor(180, 83, 9);
    doc.setLineWidth(0.7);
    doc.line((width / 2) - 38, 66.5, (width / 2) + 38, 66.5);

    // 7. Texto introductorio
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(87, 83, 78);
    doc.text("Se certifica que", width / 2, 76, { align: 'center' });

    // 8. Nombre del Alumno
    doc.setFont("times", "bold");
    doc.setFontSize(25);
    doc.setTextColor(28, 25, 23);
    doc.text(studentName, width / 2, 89, { align: 'center' });

    if (docInfo) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(120, 113, 108);
      doc.text(`Identificación: ${docInfo}`, width / 2, 95.5, { align: 'center' });
    }

    // Subrayado limpio
    doc.setDrawColor(214, 211, 209);
    doc.setLineWidth(0.5);
    const nameWidth = Math.max(doc.getTextWidth(studentName), 90);
    doc.line((width / 2) - (nameWidth / 2) - 10, 99, (width / 2) + (nameWidth / 2) + 10, 99);

    // 9. Texto de acreditación y Curso
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(87, 83, 78);
    doc.text(
      "completó y aprobó satisfactoriamente las 7 lecciones prácticas del curso:",
      width / 2,
      108,
      { align: 'center' }
    );

    doc.setFont("helvetica", "bold");
    doc.setFontSize(19);
    doc.setTextColor(15, 118, 110);
    doc.text("IA EN 7 DÍAS: INTELIGENCIA ARTIFICIAL APLICADA AL TRABAJO", width / 2, 119, { align: 'center' });

    // 10. Descripción sobria de competencias
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(87, 83, 78);
    const descriptionText =
      "Cumpliendo el 100% de las actividades prácticas verificadas en estructuración de prompts (método R-C-T-F), " +
      "redacción profesional asistida, análisis de documentos, automatización de hojas de cálculo, generación visual " +
      "y auditoría de calidad con Inteligencia Artificial. Intensidad certificada: 15 horas teórico-prácticas.";
    
    const splitDesc = doc.splitTextToSize(descriptionText, 215);
    doc.text(splitDesc, width / 2, 128, { align: 'center' });

    // 11. Bloque inferior en 3 columnas limpias: Fecha | Sello de Verificación | Firma y Referencia
    const footerY = 164;

    // Columna Izquierda: Fecha de Emisión e ID de Referencia
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(87, 83, 78);
    doc.text("FECHA DE EMISIÓN", 34, footerY - 8);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
    doc.setTextColor(28, 25, 23);
    doc.text(formattedDate, 34, footerY - 2);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(87, 83, 78);
    doc.text("ID DE REFERENCIA", 34, footerY + 7);
    doc.setFont("courier", "bold");
    doc.setFontSize(11);
    doc.setTextColor(15, 118, 110);
    doc.text(certCode, 34, footerY + 13);

    // Columna Central: Sello sobrio
    const sealX = width / 2;
    const sealY = footerY + 2;
    doc.setFillColor(240, 253, 250);
    doc.setDrawColor(15, 118, 110);
    doc.setLineWidth(0.8);
    doc.circle(sealX, sealY, 13, 'FD');
    doc.setLineWidth(0.35);
    doc.circle(sealX, sealY, 10.8, 'S');

    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.8);
    doc.setTextColor(15, 118, 110);
    doc.text("VERIFICADO", sealX, sealY - 1.2, { align: 'center' });
    doc.setFontSize(6.2);
    doc.setTextColor(28, 25, 23);
    doc.text("7 LECCIONES", sealX, sealY + 2.5, { align: 'center' });

    // Columna Derecha: Firma del Responsable
    const sigX = width - 62;
    doc.setDrawColor(28, 25, 23);
    doc.setLineWidth(0.6);
    doc.line(sigX - 28, footerY + 2, sigX + 28, footerY + 2);

    doc.setFont("times", "italic");
    doc.setFontSize(13.5);
    doc.setTextColor(28, 25, 23);
    doc.text("Samuel Calderón Franco", sigX, footerY - 2, { align: 'center' });

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(28, 25, 23);
    doc.text("DIRECTOR DEL PROGRAMA", sigX, footerY + 8, { align: 'center' });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.2);
    doc.setTextColor(120, 113, 108);
    doc.text("IA en 7 Días • Colombia", sigX, footerY + 13, { align: 'center' });

    // 12. Pie de página legal
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.2);
    doc.setTextColor(120, 113, 108);
    doc.text(
      `Certificado de educación informal y actualización práctica emitido en Colombia • Verificación: iaen7dias.vercel.app • Ref: ${certCode}`,
      width / 2,
      191,
      { align: 'center' }
    );

    // Guardar y descargar
    const cleanFilename = `Certificado-IA-7-Dias-${studentName.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    doc.save(cleanFilename);
  }
};
